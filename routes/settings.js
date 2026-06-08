const { Setting } = require('../models/setting');
const express = require('express');
const router = express.Router();

/**
 * Helper to ensure a setting document exists.
 */
async function getOrCreateSetting() {
    let setting = await Setting.findOne();
    if (!setting) {
        setting = new Setting({ maxStockLimit: 255 });
        await setting.save();
    }
    return setting;
}

/**
 * GET /api/v1/settings
 * @desc Get global application settings
 * @access Public (or Admin, depending on requirement. Let's make it public so frontend can know max limit if needed, or we can restrict it. Actually, only admin needs it for products.)
 */
router.get('/', async (req, res) => {
    // SECURITY: Only Admins can view settings
    if (!req.auth?.isAdmin) return res.status(403).json({ message: 'Access denied. Admin only.' });

    try {
        const setting = await getOrCreateSetting();
        res.status(200).json(setting);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * PUT /api/v1/settings
 * @desc Update global application settings
 * @access Super Admin
 */
router.put('/', async (req, res) => {
    // SECURITY: Only Super Admins can update settings
    if (!req.auth?.isSuperAdmin) return res.status(403).json({ message: 'Access denied. Super Admin only.' });

    try {
        const { maxStockLimit } = req.body;
        
        if (typeof maxStockLimit !== 'number' || !Number.isInteger(maxStockLimit) || maxStockLimit < 0 || maxStockLimit > 1000000) {
            return res.status(400).json({ message: 'Invalid max stock limit. Must be an integer between 0 and 1,000,000' });
        }

        let setting = await getOrCreateSetting();
        setting.maxStockLimit = maxStockLimit;
        await setting.save();

        res.status(200).json(setting);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
