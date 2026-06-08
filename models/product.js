/**
 * @fileoverview Product Database Model.
 * Defines the schema for inventory items, establishing a relational 
 * link to the Category model and tracking available stock.
 */

const mongoose = require('mongoose');

const productSchema = mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String, required: true },
    richDescription: { type: String, default: '' },
    
    // Media
    image: { type: String, default: '' }, // Main thumbnail (Cloudinary URL)
    images: [{ type: String }], // Optional gallery array
    
    // Specifications
    brand: { type: String, default: '' },
    price : { type: Number, default: 0 },
    category: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category', // Establishes a relationship with the Category table
        required: true,
        index: true
    },
    
    // Inventory & Metrics
    countInStock: { type: Number, required: true, min: 0 },
    rating: { type: Number, default: 0 },
    numReviews: { type: Number, default: 0 },
    isFeatured: { type: Boolean, default: false },
    dateCreated: { type: Date, default: Date.now },
});

// --- VIRTUAL ID MAPPING ---
productSchema.virtual('id').get(function () {
    return this._id.toHexString();
});

productSchema.set('toJSON', { virtuals: true });

exports.Product = mongoose.model('Product', productSchema);