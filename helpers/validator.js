/**
 * @fileoverview Data Validation Schemas (Joi).
 * Defines strict validation rules for incoming HTTP requests to ensure data integrity
 * and prevent malicious payloads from reaching the database.
 */

const Joi = require('joi');

// Global Regex for international phone numbers (allows leading + and 10-15 digits)
const phoneRegex = /^\+?[0-9]{10,15}$/;

/**
 * Schema for new user registration.
 * Enforces strict email domains and precise phone number formatting.
 */
const registerSchema = Joi.object({
    name: Joi.string().min(3).max(50).required(),
    email: Joi.string().email({ minDomainSegments: 2, tlds: { allow: ['com', 'net', 'in', 'org', 'co'] } }).required(),
    password: Joi.string().min(6).required(),
    phone: Joi.string().pattern(phoneRegex).required().messages({
        'string.pattern.base': 'Phone number must be between 10 to 15 digits and can only contain numbers and a leading +.'
    }),

    street: Joi.string().allow(''),
    apartment: Joi.string().allow(''),
    zip: Joi.string().pattern(/^[0-9]+$/).allow('').messages({
        'string.pattern.base': 'ZIP code must only contain numbers.'
    }),
    city: Joi.string().allow(''),
    state: Joi.string().allow(''),
    country: Joi.string().allow('')
});

/**
 * Extended schema for admin-created users (allows isAdmin field).
 */
const adminRegisterSchema = registerSchema.keys({
    isAdmin: Joi.boolean()
});

/**
 * Schema for updating existing users.
 * Similar to registration, but password is optional.
 */
const updateUserSchema = Joi.object({
    name: Joi.string().min(3).max(50).required(),
    email: Joi.string().email({ minDomainSegments: 2, tlds: { allow: ['com', 'net', 'in', 'org', 'co'] } }).required(),
    password: Joi.string().min(6).allow(''), 
    phone: Joi.string().pattern(phoneRegex).required().messages({
        'string.pattern.base': 'Phone number must be between 10 to 15 digits and can only contain numbers and a leading +.'
    }),
    isAdmin: Joi.boolean(),
    street: Joi.string().allow(''),
    apartment: Joi.string().allow(''),
    zip: Joi.string().pattern(/^[0-9]+$/).allow('').messages({
        'string.pattern.base': 'ZIP code must only contain numbers.'
    }),
    city: Joi.string().allow(''),
    state: Joi.string().allow(''),
    country: Joi.string().allow('')
});

/**
 * Schema for authenticating users.
 */
const loginSchema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
});

/**
 * Schema for creating and updating inventory products.
 * Enforces numerical constraints on prices, stock counts, and ratings.
 */
const productSchema = Joi.object({
    name: Joi.string().required(),
    description: Joi.string().required(),
    richDescription: Joi.string().allow(''),
    brand: Joi.string().allow(''),
    price: Joi.number().min(0).required(),
    category: Joi.string().hex().length(24).required(), // Ensures a valid 24-character MongoDB ObjectId
    countInStock: Joi.number().min(0).max(255).required(),
    rating: Joi.number().min(0).max(5).allow(''),
    numReviews: Joi.number().min(0).allow(''),
    isFeatured: Joi.boolean()
});

/**
 * Schema for individual items within an order array.
 */
const orderItemSchema = Joi.object({
    product: Joi.string().hex().length(24).required(),
    quantity: Joi.number().min(1).required()
});

/**
 * Schema for processing customer checkout orders.
 * Validates the entire shopping cart array and strict shipping details.
 */
const orderSchema = Joi.object({
    orderItems: Joi.array().items(orderItemSchema).min(1).required(),
    shippingAddress1: Joi.string().required(),
    shippingAddress2: Joi.string().allow(''),
    city: Joi.string().required(),
    state: Joi.string().required(),
    zip: Joi.string().pattern(/^[0-9]+$/).required().messages({
        'string.pattern.base': 'ZIP code must only contain numbers.'
    }),
    country: Joi.string().required(),
    phone: Joi.string().pattern(phoneRegex).required().messages({
        'string.pattern.base': 'Phone number must be between 10 to 15 digits and can only contain numbers and an optional leading +.'
    }),
    status: Joi.string().valid('Pending', 'Processing', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled'),
    user: Joi.string().hex().length(24).allow(null) // Can be null for guest checkout
});

/**
 * Schema for contact form submissions.
 */
const contactSchema = Joi.object({
    name: Joi.string().min(2).max(100).required(),
    email: Joi.string().email().required(),
    subject: Joi.string().min(2).max(200).required(),
    message: Joi.string().min(10).max(5000).required()
});

module.exports = {
    registerSchema,
    adminRegisterSchema,
    updateUserSchema,
    loginSchema,
    productSchema,
    orderSchema,
    contactSchema
};