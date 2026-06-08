/**
 * @fileoverview Category Management Routes.
 * Handles CRUD operations for product categories, including Cloudinary 
 * image uploads and safe image deletion (Garbage Collection).
 */

const { Category } = require('../models/category');
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { cloudinary, createUploader } = require('../helpers/cloudinary');

const uploadOptions = createUploader('jgm-categories');

/* =========================================================
   1. CATEGORY RETRIEVAL
========================================================= */

/**
 * @route   GET /api/v1/categories/
 * @desc    Get a list of all product categories.
 * @access  Public
 */
router.get(`/`, async (req, res) => {
    const categoryList = await Category.find();
    if (!categoryList) return res.status(500).json({ success: false });
    res.status(200).send(categoryList);
});

/**
 * @route   GET /api/v1/categories/:id
 * @desc    Get details of a specific category by ID.
 * @access  Public
 */
router.get('/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid Category Id' });
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(500).json({ message: 'The category with the given ID was not found.' });
    res.status(200).send(category);
});

/* =========================================================
   2. ADMIN CATEGORY MANAGEMENT (CRUD)
========================================================= */

/**
 * @route   POST /api/v1/categories/
 * @desc    Create a new category and upload its cover image to Cloudinary.
 * @access  Admin
 */
router.post('/', uploadOptions.single('image'), async (req, res) => {
    const file = req.file;
    let imagepath = '';
    if (file) {
        imagepath = file.path; // Secure Cloudinary URL
    }

    let category = new Category({
        name: req.body.name,
        icon: req.body.icon,
        color: req.body.color,
        image: imagepath
    });

    category = await category.save();
    if (!category) return res.status(400).json({ message: 'The category cannot be created!' });
    res.send(category);
});

/**
 * @route   PUT /api/v1/categories/:id
 * @desc    Update a category. Automatically deletes the old Cloudinary image if replaced.
 * @access  Admin
 */
router.put('/:id', uploadOptions.single('image'), async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid Category Id' });
    const categoryExists = await Category.findById(req.params.id);
    if (!categoryExists) return res.status(400).json({ message: 'Invalid Category!' });

    const file = req.file;
    let imagepath;

    if (file) {
        imagepath = file.path; // Use the new uploaded image
        
        // --- CLOUDINARY GARBAGE COLLECTION ---
        // Prevents old category images from permanently taking up storage space
        if (categoryExists.image) {
            const urlParts = categoryExists.image.split('/');
            const filename = urlParts[urlParts.length - 1];
            const publicId = `jgm-categories/${filename.split('.')[0]}`; 
            
            try {
                await cloudinary.uploader.destroy(publicId);
            } catch (err) {
                console.error("Failed to delete old category image:", err);
            }
        }
    } else {
        imagepath = categoryExists.image; // Retain the existing image if no new file is provided
    }

    const category = await Category.findByIdAndUpdate(
        req.params.id,
        {
            name: req.body.name,
            icon: req.body.icon || categoryExists.icon,
            color: req.body.color,
            image: imagepath
        },
        { returnDocument: 'after' }
    );

    if (!category) return res.status(400).json({ message: 'The category cannot be updated!' });
    res.send(category);
});

/**
 * @route   DELETE /api/v1/categories/:id
 * @desc    Delete a category and permanently remove its image from Cloudinary.
 * @access  Admin
 */
router.delete('/:id', async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid Category Id' });
        const category = await Category.findById(req.params.id);
        
        if (!category) {
            return res.status(404).json({ success: false, message: "Category not found!" });
        }

        // --- CLOUDINARY GARBAGE COLLECTION ---
        if (category.image) {
            const urlParts = category.image.split('/');
            const filename = urlParts[urlParts.length - 1];
            const publicId = `jgm-categories/${filename.split('.')[0]}`;
            
            try {
                await cloudinary.uploader.destroy(publicId);
            } catch (err) {
                console.error("Failed to delete category image:", err);
            }
        }

        // Remove from Database
        await Category.findByIdAndDelete(req.params.id);
        
        return res.status(200).json({ success: true, message: 'The category and image are deleted!' });
        
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;