/**
 * @fileoverview Order Repository.
 * Centralizes all data access and business logic for Orders.
 */

const { Order } = require("../models/order");
const { Product } = require("../models/product");
const mongoose = require("mongoose");

class OrderRepository {
    /**
     * Get a paginated list of all orders.
     */
    async findAll(page = 1, limit = 10) {
        const skip = (page - 1) * limit;
        const orders = await Order.find()
            .populate("user", "name")
            .sort({ dateOrdered: -1 })
            .skip(skip)
            .limit(limit);
        const totalCount = await Order.countDocuments();
        return { orders, totalCount };
    }

    /**
     * Get a specific order by ID with details.
     */
    async findById(id) {
        return await Order.findById(id)
            .populate("user", "name email")
            .populate("orderItems.product");
    }

    /**
     * Find an order by transaction ID.
     */
    async findByTransactionId(transactionId) {
        return await Order.findOne({ transactionId });
    }

    /**
     * Get all orders for a specific user.
     */
    async findByUserId(userId) {
        return await Order.find({ user: userId })
            .populate("orderItems.product")
            .sort({ dateOrdered: -1 });
    }

    /**
     * Create a new order within a transaction.
     */
    async create(orderData, session) {
        let order = new Order(orderData);
        return await order.save({ session });
    }

    /**
     * Update an order by ID.
     */
    async update(id, updateData, session = null) {
        const options = { returnDocument: "after" };
        if (session) options.session = session;
        return await Order.findByIdAndUpdate(id, updateData, options);
    }

    /**
     * Delete an order by ID.
     */
    async delete(id) {
        return await Order.findByIdAndDelete(id);
    }

    /**
     * Atomic stock restoration logic.
     * Ensures inventory is only incremented ONCE per order.
     */
    async restoreStock(orderId) {
        // Perform an atomic update to set isStockRestored to true if it was false
        const order = await Order.findOneAndUpdate(
            { 
                _id: orderId, 
                isStockRestored: false
            },
            { $set: { isStockRestored: true } },
            { returnDocument: 'after' }
        );

        if (!order) return false; 

        // Increment inventory for each item
        const restorationPromises = order.orderItems.map(item => {
            if (item.product) {
                return Product.findByIdAndUpdate(item.product, {
                    $inc: { countInStock: item.quantity }
                });
            }
        });

        await Promise.all(restorationPromises);
        return true;
    }

    /**
     * Cancel an order and restore stock atomically.
     * Ensures inventory is only restored once.
     */
    async cancelAndRestoreStock(orderId) {
        // Atomic update: only update if status is not already Cancelled
        const order = await Order.findOneAndUpdate(
            {
                _id: orderId,
                status: { $ne: "Cancelled" }
            },
            {
                $set: {
                    status: "Cancelled",
                    paymentStatus: "Failed"
                }
            },
            { returnDocument: "after" }
        );

        if (!order) {
            // Already cancelled, or order doesn't exist.
            return false;
        }

        // Now restore stock (which is also gated by isStockRestored: false)
        await this.restoreStock(orderId);
        return true;
    }

    /**
     * Aggregates dashboard statistics.
     */
    async getDashboardStats() {
        const totalOrders = await Order.countDocuments();

        const statusCountsAgg = await Order.aggregate([
            { $group: { _id: "$status", count: { $sum: 1 } } },
        ]);
        const statusCounts = statusCountsAgg.reduce((acc, curr) => {
            acc[curr._id] = curr.count;
            return acc;
        }, {});

        const salesAgg = await Order.aggregate([
            { $match: { status: { $ne: "Cancelled" } } },
            {
                $group: {
                    _id: null,
                    totalSales: {
                        $sum: { $convert: { input: "$totalPrice", to: "double", onError: 0, onNull: 0 } },
                    },
                },
            },
        ]);
        const totalSales = salesAgg.length > 0 ? salesAgg[0].totalSales : 0;

        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - 14);

        const dailySales = await Order.aggregate([
            {
                $match: {
                    dateOrdered: { $gte: pastDate },
                    status: { $ne: "Cancelled" },
                },
            },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$dateOrdered" } },
                    totalSales: {
                        $sum: { $convert: { input: "$totalPrice", to: "double", onError: 0, onNull: 0 } },
                    },
                },
            },
            { $sort: { _id: 1 } },
        ]);

        const recentOrders = await Order.find()
            .populate("user", "name")
            .sort({ dateOrdered: -1 })
            .limit(5);

        return {
            totalOrders,
            statusCounts,
            totalSales,
            dailySales,
            recentOrders,
        };
    }

    /**
     * Automatically cancels orders that have been in "Pending" payment status for too long.
     */
    async cleanupStaleOrders(timeoutMs) {
        const cutoffTime = new Date(Date.now() - timeoutMs);
        const staleOrders = await Order.find({ 
            paymentStatus: "Pending", 
            dateOrdered: { $lt: cutoffTime } 
        });

        let processedCount = 0;
        for (const order of staleOrders) {
            try {
                const cancelled = await this.cancelAndRestoreStock(order._id);
                if (cancelled) {
                    processedCount++;
                }
            } catch (err) {
                console.error(`❌ Cleanup failed for stale order ${order._id}:`, err.message);
            }
        }
        return processedCount;
    }

    async markAsPaidIfPending(orderId, updates) {
        const result = await Order.updateOne(
            { 
                _id: orderId, 
                paymentStatus: "Pending"
            },
            { $set: updates }
        );
        return result.modifiedCount > 0;
    }
}

module.exports = new OrderRepository();
