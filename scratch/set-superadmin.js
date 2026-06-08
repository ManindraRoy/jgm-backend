/**
 * One-time script to promote an admin to Super Admin.
 * Usage: node scratch/set-superadmin.js
 */
require('dotenv/config');
const mongoose = require('mongoose');
const { User } = require('../models/user');

const TARGET_EMAIL = 'admin@jgmindustries.in';

async function run() {
    await mongoose.connect(process.env.CONNECTION_STRING, { dbName: 'jgm-db' });
    console.log('✅ Connected to DB');

    const result = await User.findOneAndUpdate(
        { email: TARGET_EMAIL },
        { $set: { isSuperAdmin: true } },
        { new: true }
    );

    if (result) {
        console.log(`🔑 ${result.email} is now a Super Admin (isSuperAdmin: ${result.isSuperAdmin})`);
    } else {
        console.log(`❌ No user found with email: ${TARGET_EMAIL}`);
    }

    await mongoose.connection.close();
}

run().catch(err => { console.error(err); process.exit(1); });
