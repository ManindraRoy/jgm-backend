/**
 * @fileoverview Order Database Model.
 * Defines the schema for customer checkouts. Uses an embedded sub-schema 
 * for order items to ensure items remain tightly coupled to the parent order.
 */

const mongoose = require('mongoose');

// --- 1. EMBEDDED SUB-SCHEMA: Order Items ---
// _id: false prevents MongoDB from creating redundant ObjectIds for these subdocuments
const orderItemSchema = mongoose.Schema({
    quantity: { type: Number, required: true },
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    }
}, { _id: false }); 

// --- 2. MAIN SCHEMA: The Order ---
const orderSchema = mongoose.Schema({
    // Embed the items directly instead of referencing external documents
    orderItems: [orderItemSchema], 
    
    // Logistics
    shippingAddress1: { type: String, required: true },
    shippingAddress2: { type: String },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zip: { type: String, required: true },
    country: { type: String, required: true },
    phone: { type: String, required: true },
    status: { type: String, required: true, default: 'Pending' },
    
    // Financials & Ownership
    totalPrice: { type: Number },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    dateOrdered: { type: Date, default: Date.now, index: true },
    
    // Gateway Payments & Tracking
    paymentStatus: { type: String, default: 'Pending', index: true },
    transactionId: { type: String, index: { unique: true, sparse: true } },
    gatewayTransactionId: { type: String },
    isStockRestored: { type: Boolean, default: false },
    courierName: { type: String, default: '' },
    trackingNumber: { type: String, default: '' }
});

// --- VIRTUAL ID MAPPING ---
orderSchema.virtual('id').get(function () {
    return this._id.toHexString();
});

orderSchema.set('toJSON', { virtuals: true });

exports.Order = mongoose.model('Order', orderSchema);