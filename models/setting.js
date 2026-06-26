const mongoose = require('mongoose');

const settingSchema = mongoose.Schema({
    maxStockLimit: { 
        type: Number, 
        required: true, 
        default: 255 
    },
    notificationEmailId: {
        type: String,
        default: 'jgmpayment@gmail.com'
    }
});

exports.Setting = mongoose.model('Setting', settingSchema);
