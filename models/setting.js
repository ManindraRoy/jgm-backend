const mongoose = require('mongoose');

const settingSchema = mongoose.Schema({
    maxStockLimit: { 
        type: Number, 
        required: true, 
        default: 255 
    }
});

exports.Setting = mongoose.model('Setting', settingSchema);
