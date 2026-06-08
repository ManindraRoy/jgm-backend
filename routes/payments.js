/**
 * @fileoverview Payment Gateway Routes (PhonePe V2 Checkout API).
 * Production-hardened implementation with OAuth2 dynamic access token caching and verification.
 */

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const orderRepository = require("../repositories/OrderRepository");

// Guard the status route against client polling flooding (e.g. max 5 requests per 10 seconds)
const statusLimiter = rateLimit({
    windowMs: 10 * 1000, // 10 seconds sliding window
    max: 5, // Limit each IP to 5 requests per window
    message: { message: "Too many status checks, please wait a few seconds before trying again." },
    skip: () => process.env.NODE_ENV === 'test' // Skip rate limiting during automated testing
});

const CLIENT_ID = process.env.PHONEPE_MERCHANT_ID;
const CLIENT_SECRET = process.env.PHONEPE_SALT_KEY;
const CLIENT_VERSION = process.env.PHONEPE_SALT_INDEX || "1";
const WEBHOOK_USERNAME = process.env.PHONEPE_WEBHOOK_USERNAME;
const WEBHOOK_PASSWORD = process.env.PHONEPE_WEBHOOK_PASSWORD;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ CRITICAL: PhonePe Client ID or Client Secret (environment configurations) are missing!");
}

// Dynamic environment evaluation to support test environment isolation
const isProd = () => process.env.PHONEPE_ENV === 'PROD';

// OAuth Access Token Caching logic
let cachedToken = null;
let tokenExpiresAt = 0; // Epoch seconds

const getAccessToken = async () => {
    const now = Math.floor(Date.now() / 1000);
    // Use cached token if it exists and has at least 60 seconds of validity remaining
    if (cachedToken && tokenExpiresAt > now + 60) {
        return cachedToken;
    }

    const authUrl = isProd()
        ? "https://api.phonepe.com/apis/identity-manager/v1/oauth/token"
        : "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token";

    const params = new URLSearchParams();
    params.append("client_id", CLIENT_ID);
    params.append("client_version", CLIENT_VERSION);
    params.append("client_secret", CLIENT_SECRET);
    params.append("grant_type", "client_credentials");

    const response = await axios.post(authUrl, params.toString(), {
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        timeout: 10000
    });

    const data = response.data;
    if (!data.access_token) {
        throw new Error("Failed to obtain access token from PhonePe");
    }

    cachedToken = data.access_token;
    // Set expiry timestamp (default to 1 hour from now if not explicitly provided)
    tokenExpiresAt = data.expires_at || (now + 3600);
    return cachedToken;
};

const initiatePayment = async (orderId) => {
    const order = await orderRepository.findById(orderId);
    if (!order) {
        const error = new Error("Order not found");
        error.isOrderNotFound = true;
        throw error;
    }

    if (order.paymentStatus === "Paid") {
        throw new Error("Order has already been paid for");
    }

    const amountInPaise = Math.round(order.totalPrice * 100);
    const randomPart = crypto.randomBytes(4).toString("hex");
    const merchantTransactionId = `JGM-${order._id.toString().slice(-6)}-${Date.now()}-${randomPart}`;

    // Mutate state prior to remote request execution to completely mitigate webhook timing issues
    await orderRepository.update(order._id, { transactionId: merchantTransactionId });

    const token = await getAccessToken();

    const payload = {
        merchantOrderId: merchantTransactionId,
        amount: amountInPaise,
        expireAfter: 1200,
        paymentFlow: {
            type: "PG_CHECKOUT",
            merchantUrls: {
                redirectUrl: `${process.env.FRONTEND_URL}/payment-success/${order._id}`
            }
        }
    };

    const checkoutUrl = isProd()
        ? "https://api.phonepe.com/apis/pg/checkout/v2/pay"
        : "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay";

    const response = await axios.post(checkoutUrl, payload, {
        headers: {
            "Content-Type": "application/json",
            "Authorization": `O-Bearer ${token}`,
            "Accept": "application/json"
        },
        timeout: 10000
    });

    if (!response.data?.redirectUrl) {
        throw new Error("Invalid malformed structural mapping returned from gateway API.");
    }

    return response.data.redirectUrl;
};

router.post("/checkout/:orderId", async (req, res) => {
    try {
        const paymentUrl = await initiatePayment(req.params.orderId);
        res.status(200).json({ success: true, paymentUrl });
    } catch (error) {
        console.error("PhonePe Checkout Error:", error.response?.data || error.message);
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
        console.error("PhonePe Redirect Error:", error.response?.data || error.message);
        if (error.isOrderNotFound) {
            return res.status(404).send("Order not found");
        }
        res.status(500).send("Payment initiation failed");
    }
});

router.post("/webhook", async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];

        if (!authHeader) {
            return res.status(401).send("Missing payload authentication credentials");
        }

        // Construct expected auth using SHA256 of username:password
        const credentials = `${WEBHOOK_USERNAME}:${WEBHOOK_PASSWORD}`;
        const expectedAuth = crypto.createHash("sha256").update(credentials).digest("hex");

        // SECURITY: Timing-safe comparison to prevent timing attacks
        const authBuffer = Buffer.from(authHeader.toLowerCase());
        const expectedBuffer = Buffer.from(expectedAuth.toLowerCase());
        const isMatch = authBuffer.length === expectedBuffer.length &&
                        crypto.timingSafeEqual(authBuffer, expectedBuffer);

        if (!isMatch) {
            return res.status(401).send("Invalid Webhook Authentication Signature");
        }

        const event = req.body?.event;
        const payload = req.body?.payload;

        if (!event || !payload) {
            return res.status(400).send("Missing payload requirements");
        }

        const merchantTxnId = payload.merchantOrderId;
        if (!merchantTxnId) return res.status(400).send("Missing Identification parameter context");

        const order = await orderRepository.findByTransactionId(merchantTxnId);
        if (!order) return res.status(404).send("Order reference pointer mismatch");

        if (order.paymentStatus === "Paid" || order.paymentStatus === "Failed") {
            return res.status(200).send("OK");
        }

        const expectedAmount = Math.round(order.totalPrice * 100);
        if (event === "checkout.order.completed" && payload.state === "COMPLETED" && payload.amount === expectedAmount) {
            await orderRepository.markAsPaidIfPending(order._id, {
                paymentStatus: "Paid",
                status: "Processing",
                gatewayTransactionId: payload.orderId
            });
        } else if (event === "checkout.order.failed" || (payload.state && payload.state !== "PENDING" && payload.state !== "COMPLETED")) {
            await orderRepository.cancelAndRestoreStock(order._id);
        }

        res.status(200).send("OK");
    } catch (error) {
        console.error("Critical Webhook Processing Fault:", error);
        res.status(500).send("Internal Server Exception Context Captured");
    }
});

router.get("/check-status/:orderId", statusLimiter, async (req, res) => {
    try {
        const order = await orderRepository.findById(req.params.orderId);
        if (!order) return res.status(404).json({ message: "Order not found" });

        if (order.paymentStatus === "Paid" || order.paymentStatus === "Failed") {
            return res.json({ paymentStatus: order.paymentStatus, orderStatus: order.status });
        }

        if (!order.transactionId) {
            await orderRepository.cancelAndRestoreStock(order._id);
            return res.json({ paymentStatus: "Failed", orderStatus: "Cancelled" });
        }

        const token = await getAccessToken();

        const statusBaseUrl = isProd()
            ? "https://api.phonepe.com/apis/pg/checkout/v2/order"
            : "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/order";

        let response;
        try {
            response = await axios.get(`${statusBaseUrl}/${order.transactionId}/status`, {
                headers: {
                    "Authorization": `O-Bearer ${token}`,
                    "Accept": "application/json"
                },
                timeout: 8000
            });
        } catch (axiosError) {
            console.warn(`⚠️ PhonePe Status API connection warning: ${axiosError.message}`);
            return res.json({ paymentStatus: "Pending", orderStatus: order.status, note: "Gateway synchronizing state." });
        }

        const state = response.data?.state;
        const expectedAmount = Math.round(order.totalPrice * 100);

        if (state === "COMPLETED" && response.data?.amount === expectedAmount) {
            await orderRepository.markAsPaidIfPending(order._id, {
                paymentStatus: "Paid",
                status: "Processing",
                gatewayTransactionId: response.data.orderId || null
            });
            return res.json({ paymentStatus: "Paid", orderStatus: "Processing" });
        } else if (state === "PENDING") {
            return res.json({ paymentStatus: "Pending", orderStatus: order.status });
        } else {
            await orderRepository.cancelAndRestoreStock(order._id);
            return res.json({ paymentStatus: "Failed", orderStatus: "Cancelled" });
        }
    } catch (error) {
        console.error("Status Check Error Runtime Exception:", error.message);
        res.status(500).json({ message: "Failed to verify current payment status context" });
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

const runCleanup = async () => {
    await cleanup().catch(() => {});
    setTimeout(runCleanup, CLEANUP_INTERVAL_MS);
};

if (process.env.NODE_ENV !== 'test') {
    setTimeout(runCleanup, 10000);
}

// Expose reset token cache helper for testing
if (process.env.NODE_ENV === 'test') {
    router.clearTokenCache = () => {
        cachedToken = null;
        tokenExpiresAt = 0;
    };
}

module.exports = router;
