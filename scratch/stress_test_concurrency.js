/**
 * STRESS TEST: Concurrency Stock Restoration
 * Simulates multiple concurrent status checks/webhook hits to ensure stock
 * is only restored once.
 */
const mongoose = require('mongoose');
require('dotenv/config');
const { Order } = require('../models/order');
const { Product } = require('../models/product');
const { restoreStock } = require('../helpers/stock-manager');

async function runStressTest() {
    try {
        console.log("🚀 Starting Concurrency Stress Test...");
        
        await mongoose.connect(process.env.CONNECTION_STRING);
        console.log("✅ Connected to Database");

        // 1. Setup Test Data
        const testProduct = new Product({
            name: "Stress Test Herb",
            price: 100,
            countInStock: 50,
            category: new mongoose.Types.ObjectId(), // dummy
            description: "Testing concurrency"
        });
        await testProduct.save();

        const testOrder = new Order({
            orderItems: [{ product: testProduct._id, quantity: 2 }],
            shippingAddress1: "Test St",
            city: "Test",
            state: "TS",
            zip: "123456",
            country: "India",
            phone: "1234567890",
            totalPrice: 200,
            status: "Pending"
        });
        await testOrder.save();

        console.log(`📦 Test Setup complete. Product Stock: ${testProduct.countInStock}, Order Qty: 2`);

        // 2. Simulate Concurrent Requests
        console.log("⚡ Spawning 10 concurrent restoration requests...");
        
        const results = await Promise.allSettled([
            restoreStock(testOrder),
            restoreStock(testOrder),
            restoreStock(testOrder),
            restoreStock(testOrder),
            restoreStock(testOrder),
            restoreStock(testOrder),
            restoreStock(testOrder),
            restoreStock(testOrder),
            restoreStock(testOrder),
            restoreStock(testOrder),
        ]);

        const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
        const skipCount = results.filter(r => r.status === 'fulfilled' && r.value === false).length;

        console.log(`📊 Results: ${successCount} successful restorations, ${skipCount} skipped.`);

        // 3. Verify Final Stock
        const finalProduct = await Product.findById(testProduct._id);
        console.log(`🎯 Final Stock in DB: ${finalProduct.countInStock}`);
        
        if (finalProduct.countInStock === 52 && successCount === 1) {
            console.log("✅ SUCCESS: Stock was restored exactly once!");
        } else {
            console.log("❌ FAILURE: Stock restoration was not atomic!");
        }

        // 4. Cleanup
        await Order.findByIdAndDelete(testOrder._id);
        await Product.findByIdAndDelete(testProduct._id);
        await mongoose.connection.close();
        
    } catch (err) {
        console.error("💥 Stress test failed:", err);
        process.exit(1);
    }
}

runStressTest();
