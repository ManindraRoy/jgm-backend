/**
 * @fileoverview Product Management Routes.
 * Handles CRUD operations for the store catalog, including complex queries (filtering/pagination),
 * Multer image uploads, and safe Cloudinary image deletion (Garbage Collection).
 */

const { Product } = require("../models/product");
const { Category } = require("../models/category");
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { cloudinary, createUploader } = require("../helpers/cloudinary");
const { productSchema } = require("../helpers/validator");

const uploadOptions = createUploader("jgm-products");

/**
 * Escapes special regex characters in user input to prevent ReDoS attacks.
 * @param {string} str - Raw user input.
 * @returns {string} Escaped string safe for use in a RegExp.
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* =========================================================
   1. PRODUCT RETRIEVAL & FILTERING
========================================================= */

/**
 * @route   GET /api/v1/products/
 * @desc    Get a paginated list of products. Supports category filtering and text search.
 * @access  Public
 */
router.get(`/`, async (req, res) => {
    let filter = {};
    
    // Support URL parameters: /api/v1/products?categories=id1,id2
    if (req.query.categories) {
        filter = { category: req.query.categories.split(",") };
    }
    // Support Brand Filtering: /api/v1/products?brand=JGM
    if (req.query.brand) {
        filter.brand = { $regex: escapeRegex(req.query.brand), $options: "i" };
    }
    // Support URL search: /api/v1/products?search=oil
    if (req.query.search) {
        filter.name = { $regex: escapeRegex(req.query.search), $options: "i" };
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const productList = await Product.find(filter)
        .populate("category")
        .skip(skip)
        .limit(limit);

    const totalCount = await Product.countDocuments(filter);

    if (!productList) return res.status(500).json({ success: false });
    res.send({ products: productList, totalCount, page, limit });
});

/**
 * @route   GET /api/v1/products/:id
 * @desc    Get detailed information for a single product.
 * @access  Public
 */
router.get(`/:id`, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ message: "Invalid Product Id" });
    }
    const product = await Product.findById(req.params.id).populate("category");
    if (!product) return res.status(500).json({ success: false });
    res.send(product);
});

/* =========================================================
   2. ADMIN PRODUCT MANAGEMENT (CRUD)
========================================================= */

/**
 * @route   POST /api/v1/products/
 * @desc    Create a new product and upload its image to Cloudinary.
 * @access  Admin
 */
router.post(`/`, uploadOptions.single("image"), async (req, res) => {
    const { error } = productSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const category = await Category.findById(req.body.category);
    if (!category) return res.status(400).json({ message: "Invalid Category" });

    const file = req.file;
    if (!file) return res.status(400).json({ message: "No image in the request" });

    let product = new Product({
        name: req.body.name,
        description: req.body.description,
        richDescription: req.body.richDescription,
        image: req.file.path, // Direct Cloudinary secure URL
        brand: req.body.brand,
        price: req.body.price,
        category: req.body.category,
        countInStock: req.body.countInStock,
        rating: req.body.rating,
        numReviews: req.body.numReviews,
        isFeatured: req.body.isFeatured,
    });

    product = await product.save();
    if (!product) return res.status(500).json({ message: "The product cannot be created" });
    res.send(product);
});

/**
 * @route   PUT /api/v1/products/:id
 * @desc    Update a product. Automatically deletes the old Cloudinary image if a new one is uploaded.
 * @access  Admin
 */
router.put("/:id", uploadOptions.single("image"), async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ message: "Invalid Product Id" });
    }

    const { error } = productSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const category = await Category.findById(req.body.category);
    if (!category) return res.status(400).json({ message: "Invalid Category" });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(400).json({ message: "Invalid Product!" });

    const file = req.file;
    let imagepath;

    if (file) {
        imagepath = file.path;
        
        // --- CLOUDINARY GARBAGE COLLECTION ---
        // Prevents orphaned files from consuming storage
        if (product.image) {
            const urlParts = product.image.split('/');
            const filename = urlParts[urlParts.length - 1];
            const publicId = `jgm-products/${filename.split('.')[0]}`;
            try {
                await cloudinary.uploader.destroy(publicId);
            } catch (err) {
                console.error("Failed to delete old image from Cloudinary:", err);
            }
        }
    } else {
        imagepath = product.image; // Retain existing image
    }

    const updatedProduct = await Product.findByIdAndUpdate(
        req.params.id,
        {
            name: req.body.name,
            description: req.body.description,
            richDescription: req.body.richDescription,
            image: imagepath,
            brand: req.body.brand,
            price: req.body.price,
            category: req.body.category,
            countInStock: req.body.countInStock,
            rating: req.body.rating,
            numReviews: req.body.numReviews,
            isFeatured: req.body.isFeatured,
        },
        { returnDocument: "after" },
    );

    if (!updatedProduct) return res.status(500).json({ message: "the product cannot be updated!" });
    res.send(updatedProduct);
});

/**
 * @route   DELETE /api/v1/products/:id
 * @desc    Delete a product and its associated Cloudinary image.
 * @access  Admin
 */
router.delete("/:id", async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, message: "Item not found!" });
        }

        // --- CLOUDINARY GARBAGE COLLECTION ---
        if (product.image) {
            const urlParts = product.image.split('/');
            const filename = urlParts[urlParts.length - 1];
            const publicId = `jgm-products/${filename.split('.')[0]}`;
            try {
                await cloudinary.uploader.destroy(publicId);
            } catch (err) {
                console.error("Failed to delete image from Cloudinary:", err);
            }
        }

        await Product.findByIdAndDelete(req.params.id);
        return res.status(200).json({ success: true, message: "Item deleted!" });
    } catch (err) {
        return res.status(500).json({ success: false, error: err });
    }
});

/**
 * @route   GET /api/v1/products/get/count
 * @desc    Get the total number of products for the Admin Dashboard.
 * @access  Admin
 */
router.get(`/get/count`, async (req, res) => {
    try {
        const productCount = await Product.countDocuments();
        res.status(200).send({ productCount: productCount });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;