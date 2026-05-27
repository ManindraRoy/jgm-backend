/**
 * @fileoverview Payment Gateway Routes.
 * Refactored to use OrderRepository for centralized order state management.
 */

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const axios = require("axios");
const orderRepository = require("../repositories/OrderRepository");

const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const SALT_KEY = process.env.PHONEPE_SALT_KEY;
const SALT_INDEX = process.env.PHONEPE_SALT_INDEX || "1";

const isProd = process.env.PHONEPE_ENV === 'PROD';
const PHONEPE_URL = isProd 
    ? "https://api.phonepe.com/apis/pg/v1/pay"              
    : "https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/pay"; 

const PHONEPE_STATUS_URL = isProd
    ? "https://api.phonepe.com/apis/pg/v1/status"
    : "https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/status";

const initiatePayment = async (orderId) => {
    const order = await orderRepository.findById(orderId);
    if (!order) {
        const error = new Error("Order not found");
        error.isOrderNotFound = true;
        throw error;
    }

    // Fast-return if order is already processed
    if (order.paymentStatus === "Paid") {
        throw new Error("Order has already been paid for");
    }

    const amountInPaise = Math.round(order.totalPrice * 100);
    const merchantTransactionId = `JGM-${order._id.toString().slice(-6)}-${Date.now()}`;

    // FIX #1: Persist transaction ID BEFORE invoking external API to eliminate Webhook race conditions
    await orderRepository.update(order._id, { transactionId: merchantTransactionId });

    const payload = {
        merchantId: MERCHANT_ID,
        merchantTransactionId: merchantTransactionId,
        merchantUserId: order.user ? (order.user._id ? order.user._id.toString() : order.user.toString()) : "GUEST-USER",
        amount: amountInPaise,
        redirectUrl: `${process.env.FRONTEND_URL}/payment-success/${order._id}`, 
        redirectMode: "REDIRECT",
        callbackUrl: process.env.PHONEPE_WEBHOOK_URL, 
        paymentInstrument: { type: "PAY_PAGE" },
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64");
    const stringToHash = base64Payload + "/pg/v1/pay" + SALT_KEY;
    const checksum = crypto.createHash("sha256").update(stringToHash).digest("hex") + "###" + SALT_INDEX;

    const response = await axios.post(PHONEPE_URL, { request: base64Payload }, {
        headers: {
            "Content-Type": "application/json",
            "X-VERIFY": checksum,
            accept: "application/json",
        },
    });

    return response.data.data.instrumentResponse.redirectInfo.url;
};

router.post("/checkout/:orderId", async (req, res) => {
    try {
        const paymentUrl = await initiatePayment(req.params.orderId);
        res.status(200).json({ success: true, paymentUrl });
    } catch (error) {
        console.error("PhonePe Error:", error.response?.data || error.message);
        if (error.isOrderNotFound) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(500).json({ success: false, message: error.message || "Payment initiation failed" });
    }
});

router.get("/checkout/:orderId", async (req, res) => {
    try {
        const paymentUrl = await initiatePayment(req.params.orderId);
        res.redirect(paymentUrl);
    } catch (error) {
        console.error("PhonePe Error:", error.response?.data || error.message);
        if (error.isOrderNotFound) {
            return res.status(404).send("Order not found");
        }
        res.status(500).send("Payment initiation failed");
    }
});

router.post("/webhook", async (req, res) => {
    try {
        const receivedChecksum = req.headers['x-verify'];
        const base64Response = req.body.response;
        const stringToHash = base64Response + SALT_KEY;
        const expectedChecksum = crypto.createHash("sha256").update(stringToHash).digest("hex") + "###" + SALT_INDEX;

        if (receivedChecksum !== expectedChecksum) return res.status(400).send("Invalid Checksum");

        const responseData = JSON.parse(Buffer.from(base64Response, "base64").toString("utf8"));
        const order = await orderRepository.findByTransactionId(responseData.data.merchantTransactionId);
        if (!order) return res.status(404).send("Order not found");

        // Guard: If already processed via status check pool, don't perform actions again
        if (order.paymentStatus === "Paid" || order.paymentStatus === "Failed") {
            return res.status(200).send("OK");
        }

        const expectedAmount = Math.round(order.totalPrice * 100);
        if (responseData.code === "PAYMENT_SUCCESS" && responseData.data.amount === expectedAmount) {
            await orderRepository.update(order._id, {
                paymentStatus: "Paid",
                status: "Processing",
                gatewayTransactionId: responseData.data.transactionId // FIX #3: Saved distinctly to preserve query criteria lookup integrity
            });
        } else if (responseData.code !== "PAYMENT_PENDING") {
            // Defend against redundant multi-triggers mutating stock state
            if (order.status !== "Cancelled") {
                await orderRepository.restoreStock(order._id);
            }
            await orderRepository.update(order._id, { paymentStatus: "Failed", status: "Cancelled" });
        }

        res.status(200).send("OK");
    } catch (error) {
        console.error("Webhook Processing Error:", error);
        res.status(500).send("Webhook Processing Failed");
    }
});

router.get("/check-status/:orderId", async (req, res) => {
    try {
        const order = await orderRepository.findById(req.params.orderId);
        if (!order) return res.status(404).json({ message: "Order not found" });

        if (order.paymentStatus === "Paid" || order.paymentStatus === "Failed") {
            return res.json({ paymentStatus: order.paymentStatus, orderStatus: order.status });
        }

        if (!order.transactionId) {
            if (order.status !== "Cancelled") await orderRepository.restoreStock(order._id);
            await orderRepository.update(order._id, { paymentStatus: "Failed", status: "Cancelled" });
            return res.json({ paymentStatus: "Failed", orderStatus: "Cancelled" });
        }

        const statusPath = `/pg/v1/status/${MERCHANT_ID}/${order.transactionId}`;
        const checksum = crypto.createHash("sha256").update(statusPath + SALT_KEY).digest("hex") + "###" + SALT_INDEX;

        const response = await axios.get(`${PHONEPE_STATUS_URL}/${MERCHANT_ID}/${order.transactionId}`, {
            headers: { "X-VERIFY": checksum, "X-MERCHANT-ID": MERCHANT_ID },
        });

        const phonepeStatus = response.data.code;
        const expectedAmount = Math.round(order.totalPrice * 100);

        if (phonepeStatus === "PAYMENT_SUCCESS" && response.data.data.amount === expectedAmount) {
            const updated = await orderRepository.update(order._id, {
                paymentStatus: "Paid",
                status: "Processing",
                gatewayTransactionId: response.data.data.transactionId || null
            });
            return res.json({ paymentStatus: "Paid", orderStatus: updated.status });
        } else if (phonepeStatus === "PAYMENT_PENDING") {
            return res.json({ paymentStatus: "Pending", orderStatus: order.status });
        } else {
            // FIX #2: Explicitly ensure we don't clear inventory on unvalidated API errors
            if (order.status !== "Cancelled") {
                await orderRepository.restoreStock(order._id);
            }
            const updated = await orderRepository.update(order._id, { paymentStatus: "Failed", status: "Cancelled" });
            return res.json({ paymentStatus: "Failed", orderStatus: updated.status });
        }
    } catch (error) {
        console.error("Status Check Error:", error.message);
        res.status(500).json({ message: "Failed to check status" });
    }
});

// Stale Cleanup Logic
const STALE_ORDER_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

const cleanup = async () => {
    try {
        const count = await orderRepository.cleanupStaleOrders(STALE_ORDER_TIMEOUT_MS);
        if (count > 0) console.log(`🧹 Auto-cancelled ${count} stale order(s).`);
    } catch (error) {
        console.error("❌ Background cleanup failed:", error.message);
    }
};

if (process.env.NODE_ENV !== 'test') {
    setInterval(cleanup, CLEANUP_INTERVAL_MS);
    setTimeout(cleanup, 10000);
}

module.exports = router;
