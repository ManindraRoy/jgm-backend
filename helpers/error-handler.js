/**
 * @fileoverview Global Error Handler Middleware.
 * PRODUCTION MODE: Masks internal server errors to prevent data leakage.
 */

function errorHandler(err, req, res, next) {
    // 1. Log the real error to your private Render logs
    console.error("🚨 Internal Server Error:", err);

    // 2. Auth Errors
    if (err.name === 'UnauthorizedError') {
        return res.status(401).json({ 
            success: false, 
            message: "The user is not authorized." 
        });
    }

    // 3. Validation Errors
    if (err.name === 'ValidationError') {
        return res.status(400).json({ 
            success: false, 
            message: err.message 
        });
    }

    // 4. Catch-All Server Crash (The Security Mask)
    const isProduction = process.env.NODE_ENV !== 'development';
    
    return res.status(500).json({ 
        success: false, 
        // Hide actual crash reasons from users in production
        message: isProduction ? "An internal server error occurred." : (err.message || "An unexpected error occurred."),
        // NEVER send the stack trace in production
        stack: isProduction ? null : err.stack 
    });
}

module.exports = errorHandler;
