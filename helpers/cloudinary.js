/**
 * @fileoverview Shared Cloudinary Configuration.
 * Centralizes Cloudinary setup and provides pre-configured Multer storage
 * factories for different upload folders (products, categories, etc.).
 */

const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// --- SINGLE CLOUDINARY CONFIGURATION ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

/**
 * Creates a Multer upload middleware configured for a specific Cloudinary folder.
 * @param {string} folder - The Cloudinary folder name (e.g., 'jgm-products', 'jgm-categories').
 * @returns {multer.Multer} A configured Multer instance.
 */
function createUploader(folder) {
    const storage = new CloudinaryStorage({
        cloudinary: cloudinary,
        params: {
            folder: folder,
            allowedFormats: ['jpeg', 'png', 'jpg'],
        },
    });

    return multer({
        storage: storage,
        limits: { fileSize: 5 * 1024 * 1024 } // 5MB max per image
    });
}

module.exports = { cloudinary, createUploader };
