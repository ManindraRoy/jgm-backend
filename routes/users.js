/**
 * @fileoverview User Authentication & Profile Routes.
 * PRODUCTION MODE: Strict Cross-Domain Cookie Management.
 */

const { User } = require("../models/user");
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { loginSchema, registerSchema, updateUserSchema } = require("../helpers/validator");
const { sendOtpEmail, sendContactEmail } = require("../helpers/mailer");

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 10, 
    message: { message: "Too many attempts from this IP, please try again after 15 minutes" }
});

router.post("/register", authLimiter, async (req, res) => {
    const { error } = registerSchema.validate(req.body);
    if (error) return res.status(400).send(error.details[0].message);

    // SECURITY: Prevent duplicate registrations
    let existingUser = await User.findOne({ email: req.body.email });
    
    // SECURITY: Prevent duplicate phone numbers across accounts
    const phoneInUse = await User.findOne({ phone: req.body.phone });
    if (phoneInUse && (!existingUser || phoneInUse._id.toString() !== existingUser._id.toString())) {
        return res.status(400).send("This phone number is already registered with another account.");
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryTime = new Date(Date.now() + 10 * 60 * 1000); 

    if (existingUser) {
        if (existingUser.isEmailVerified) {
            return res.status(400).send("A user with this email already exists and is verified. Please log in.");
        }
        
        // If unverified, update their details and send a new OTP
        existingUser.name = req.body.name;
        existingUser.passwordHash = bcrypt.hashSync(req.body.password, 10);
        if (req.body.phone) existingUser.phone = req.body.phone;
        existingUser.otp = otpCode;
        existingUser.otpExpires = expiryTime;
        
        await existingUser.save();
        
        try {
            await sendOtpEmail(existingUser.email, otpCode);
            return res.status(200).send({ message: "Account details updated. Please check your email for the new OTP." });
        } catch (emailError) {
            console.error("❌ Failed to send OTP email:", emailError.message);
            return res.status(500).send("Account updated but failed to send OTP email. Please try again later.");
        }
    }

    let user = new User({
        name: req.body.name,
        email: req.body.email,
        passwordHash: bcrypt.hashSync(req.body.password, 10),
        phone: req.body.phone,
        isAdmin: false, // SECURITY: Never trust client input for admin status. Admins are created only via the Admin Panel.
        otp: otpCode,
        otpExpires: expiryTime
    });

    user = await user.save();
    if (!user) return res.status(400).send("The user cannot be created!");

    try {
        await sendOtpEmail(user.email, otpCode);
        res.status(200).send({ message: "Registration successful. Please check your email for the OTP." });
    } catch (emailError) {
        console.error("❌ Failed to send OTP email:", emailError.message);
        console.error("❌ Full error:", JSON.stringify(emailError, Object.getOwnPropertyNames(emailError)));
        res.status(500).send("Account created but failed to send OTP email. Please try 'Resend OTP' or contact support.");
    }
});

router.post("/verify-email", async (req, res) => {
    const { email, otp } = req.body;

    const user = await User.findOne({ email: email });
    if (!user) return res.status(400).send("User not found.");
    if (user.isEmailVerified) return res.status(400).send("Email is already verified.");

    if (user.otp !== otp) return res.status(400).send("Invalid OTP code.");
    if (user.otpExpires < Date.now()) return res.status(400).send("OTP has expired. Please request a new one.");

    user.isEmailVerified = true;
    user.otp = undefined;
    user.otpExpires = undefined;
    await user.save();

    res.status(200).send({ message: "Email verified successfully! You can now log in." });
});

router.post("/login", authLimiter, async (req, res) => {
    const { error } = loginSchema.validate(req.body);
    if (error) return res.status(400).send(error.details[0].message);

    const user = await User.findOne({ email: req.body.email });
    const secret = process.env.secret || process.env.SECRET;

    if (!user) return res.status(400).send("The user not found");

    if (!user.isEmailVerified && !user.isAdmin) {
        return res.status(403).send("Please verify your email address before logging in.");
    }

    if (user && bcrypt.compareSync(req.body.password, user.passwordHash)) {
        const token = jwt.sign(
            { userId: user.id, isAdmin: user.isAdmin, isSuperAdmin: user.isSuperAdmin },
            secret,
            { expiresIn: "1d" }
        );

        // CRITICAL: Production Cross-Domain Cookie
        res.cookie('jgm_token', token, {
            httpOnly: true,
            secure: true,        
            sameSite: 'none',    
            maxAge: 30 * 24 * 60 * 60 * 1000 
        });

        res.status(200).send({
            message: "Logged in successfully",
            user: user.email,
            isSuperAdmin: user.isSuperAdmin || false
        });
    } else {
        res.status(400).send("password is wrong!");
    }
});

router.post("/logout", (req, res) => {
    // CRITICAL: Must match the exact settings used to create the cookie
    res.clearCookie("jgm_token", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
    });
    res.status(200).json({ message: "Logged out successfully" });
});

router.post("/forgot-password", authLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).send("Email is required");

    const user = await User.findOne({ email: email });
    if (!user) return res.status(400).send("User with this email does not exist.");

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryTime = new Date(Date.now() + 10 * 60 * 1000); 

    user.otp = otpCode;
    user.otpExpires = expiryTime;
    await user.save();

    try {
        await sendOtpEmail(user.email, otpCode);
        res.status(200).send({ message: "Password reset OTP sent to your email." });
    } catch (emailError) {
        console.error("Failed to send OTP email:", emailError);
        res.status(500).send("Failed to send email. Please try again later.");
    }
});

router.post("/reset-password", async (req, res) => {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) return res.status(400).send("All fields are required.");
    if (newPassword.length < 6) return res.status(400).send("Password must be at least 6 characters long.");

    const user = await User.findOne({ email: email });
    if (!user) return res.status(400).send("User not found.");

    if (user.otp !== otp) return res.status(400).send("Invalid OTP code.");
    if (user.otpExpires < Date.now()) return res.status(400).send("OTP has expired. Please request a new one.");

    user.passwordHash = bcrypt.hashSync(newPassword, 10);
    user.otp = undefined;
    user.otpExpires = undefined;
    await user.save();

    res.status(200).send({ message: "Password reset successfully! You can now log in." });
});

router.get("/verify-session", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Session is valid",
        isSuperAdmin: req.auth?.isSuperAdmin || false
    });
});

router.get("/me/profile", async (req, res) => {
    try {
        if (!req.auth || !req.auth.userId) return res.status(401).send("Not authenticated");
        const user = await User.findById(req.auth.userId).select("-passwordHash -otp -otpExpires");
        if (!user) return res.status(404).send("User not found");
        res.status(200).send(user);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put("/me/address", async (req, res) => {
    try {
        if (!req.auth || !req.auth.userId) return res.status(401).send("Not authenticated");

        // SECURITY: If phone is being changed, verify it's not taken by another user
        if (req.body.phone) {
            const phoneInUse = await User.findOne({ phone: req.body.phone, _id: { $ne: req.auth.userId } });
            if (phoneInUse) return res.status(400).send("This phone number is already registered with another account.");
        }
        
        const user = await User.findByIdAndUpdate(
            req.auth.userId,
            {
                street: req.body.street || '',
                apartment: req.body.apartment || '',
                city: req.body.city || '',
                state: req.body.state || '',
                zip: req.body.zip || '',
                country: req.body.country || 'India',
                ...(req.body.phone && { phone: req.body.phone })
            },
            { returnDocument: 'after', runValidators: true }
        ).select("-passwordHash -otp -otpExpires");

        if (!user) return res.status(404).send("User not found");
        res.status(200).send({ message: "Address updated successfully!", user });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/contact', async (req, res) => {
    const { name, email, subject, message } = req.body;
    try {
        await sendContactEmail(name, email, subject, message);
        res.status(200).json({ success: true, message: "Message sent successfully!" });
    } catch (error) {
        console.error('Contact Form Error:', error);
        res.status(500).json({ success: false, message: "Failed to send message." });
    }
});

router.get(`/`, async (req, res) => {
    // SECURITY: Only Super Admins can view the user directory
    if (!req.auth?.isSuperAdmin) return res.status(403).json({ message: "Access denied. Super Admin only." });

    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const userList = await User.find().select("-passwordHash").skip(skip).limit(limit);
        const totalCount = await User.countDocuments();

        if (!userList) return res.status(500).json({ success: false });
        res.send({ users: userList, totalCount, page, limit });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get("/:id", async (req, res) => {
    // SECURITY: Only Super Admins can view individual user details
    if (!req.auth?.isSuperAdmin) return res.status(403).json({ message: "Access denied. Super Admin only." });

    const user = await User.findById(req.params.id).select("-passwordHash");
    if (!user) return res.status(500).json({ message: "The user with the given ID was not found." });
    res.status(200).send(user);
});

router.post("/", async (req, res) => {
    // SECURITY: Only Super Admins can create users from admin panel
    if (!req.auth?.isSuperAdmin) return res.status(403).json({ message: "Access denied. Super Admin only." });

    const { error } = registerSchema.validate(req.body);
    if (error) return res.status(400).send(error.details[0].message);

    // SECURITY: Prevent duplicate email & phone from admin panel
    const emailExists = await User.findOne({ email: req.body.email });
    if (emailExists) return res.status(400).send("A user with this email already exists.");
    const phoneExists = await User.findOne({ phone: req.body.phone });
    if (phoneExists) return res.status(400).send("A user with this phone number already exists.");

    let user = new User({
        name: req.body.name,
        email: req.body.email,
        passwordHash: bcrypt.hashSync(req.body.password, 10),
        phone: req.body.phone,
        isAdmin: req.body.isAdmin,
        street: req.body.street,
        apartment: req.body.apartment,
        zip: req.body.zip,
        city: req.body.city,
        country: req.body.country,
        isEmailVerified: true 
    });
    
    user = await user.save();
    if (!user) return res.status(400).send("The user cannot be created!");
    res.send(user);
});

router.put("/:id", async (req, res) => {
    // SECURITY: Only Super Admins can edit user accounts
    if (!req.auth?.isSuperAdmin) return res.status(403).json({ message: "Access denied. Super Admin only." });

    const { error } = updateUserSchema.validate(req.body);
    if (error) return res.status(400).send(error.details[0].message);

    const userExist = await User.findById(req.params.id);
    if (!userExist) return res.status(400).send("Invalid User");

    // SECURITY: Check if the new phone number is already taken by a different user
    if (req.body.phone && req.body.phone !== userExist.phone) {
        const phoneInUse = await User.findOne({ phone: req.body.phone, _id: { $ne: req.params.id } });
        if (phoneInUse) return res.status(400).send("This phone number is already registered with another account.");
    }

    let newPassword = req.body.password ? bcrypt.hashSync(req.body.password, 10) : userExist.passwordHash;

    const user = await User.findByIdAndUpdate(
        req.params.id,
        {
            name: req.body.name,
            email: req.body.email,
            passwordHash: newPassword,
            phone: req.body.phone,
            isAdmin: req.body.isAdmin,
            street: req.body.street,
            apartment: req.body.apartment,
            zip: req.body.zip,
            city: req.body.city,
            country: req.body.country,
        },
        { returnDocument: "after" }
    );

    if (!user) return res.status(400).send("the user cannot be updated!");
    res.send(user);
});

router.delete("/:id", (req, res) => {
    // SECURITY: Only Super Admins can delete user accounts
    if (!req.auth?.isSuperAdmin) return res.status(403).json({ message: "Access denied. Super Admin only." });

    User.findByIdAndDelete(req.params.id)
        .then((user) => {
            if (user) return res.status(200).json({ success: true, message: "the user is deleted!" });
            else return res.status(404).json({ success: false, message: "user not found!" });
        })
        .catch((err) => res.status(500).json({ success: false, error: err }));
});

router.get(`/get/count`, async (req, res) => {
    try {
        const userCount = await User.countDocuments();
        res.status(200).send({ userCount: userCount });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
