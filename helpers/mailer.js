/**
 * @fileoverview Email Service Helper.
 * PRODUCTION: Uses Brevo HTTP API (Railway blocks ALL SMTP ports).
 * LOCAL DEV:  Uses Gmail SMTP via Nodemailer.
 */

const nodemailer = require('nodemailer');

const isProduction = process.env.NODE_ENV === 'production';

// --- DIAGNOSTIC: Check email config ---
console.log('📧 Email Config:');
console.log('  Environment:', isProduction ? 'PRODUCTION (Brevo HTTP API)' : 'LOCAL (Gmail SMTP)');
console.log('  EMAIL_USER loaded:', !!process.env.EMAIL_USER);
console.log('  EMAIL_PASS loaded:', !!process.env.EMAIL_PASS);
if (isProduction) {
    console.log('  BREVO_USER loaded:', !!process.env.BREVO_USER);
    console.log('  BREVO_PASS loaded:', !!process.env.BREVO_PASS);
}

// --- LOCAL DEV TRANSPORTER (Gmail SMTP) ---
let localTransporter = null;
if (!isProduction) {
    localTransporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    if (process.env.NODE_ENV !== 'test') {
        localTransporter.verify()
            .then(() => console.log('✅ SMTP verified — Gmail is ready to send emails'))
            .catch((err) => {
                console.error('❌ SMTP verification FAILED:', err.message);
                console.error('❌ Error code:', err.code);
            });
    }
}

// The "from" address: In production use the verified Brevo sender, locally use Gmail
const getFromAddress = () => {
    return process.env.BREVO_SENDER || process.env.EMAIL_USER;
};

/**
 * Escapes HTML special characters to prevent injection in email templates.
 * @param {string} str - Untrusted user input.
 * @returns {string} Escaped string safe for HTML context.
 */
const escapeHtml = (str) => {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

/**
 * Sends an email via Brevo's HTTP API (production only).
 * Uses HTTPS on port 443 — bypasses Railway's SMTP port blocks.
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.replyTo] - Optional reply-to address
 */
const sendViaBrevoAPI = async ({ to, subject, html, replyTo }) => {
    const senderEmail = getFromAddress();
    
    const body = {
        sender: { name: 'JGM Industries', email: senderEmail },
        to: [{ email: to }],
        subject: subject,
        htmlContent: html
    };

    if (replyTo) {
        body.replyTo = { email: replyTo };
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'api-key': process.env.BREVO_PASS,
            'content-type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(`Brevo API error: ${response.status} ${response.statusText}`);
        error.statusCode = response.status;
        error.details = errorData;
        throw error;
    }

    const result = await response.json();
    console.log('✅ Email sent via Brevo API, messageId:', result.messageId);
    return result;
};

// --- PRODUCTION STARTUP CHECK ---
if (isProduction) {
    // Quick health check — hit Brevo's account endpoint to verify the API key works
    fetch('https://api.brevo.com/v3/account', {
        headers: { 'api-key': process.env.BREVO_PASS }
    })
    .then(res => {
        if (res.ok) {
            console.log('✅ Brevo API key verified — HTTP API is ready to send emails');
        } else {
            console.error('❌ Brevo API key verification FAILED. Status:', res.status);
        }
    })
    .catch(err => console.error('❌ Brevo API connectivity check failed:', err.message));
}

/**
 * Dispatches an HTML-formatted email containing a 6-digit OTP code.
 * @param {string} userEmail - The recipient's email address.
 * @param {string} otpCode - The 6-digit security code.
 * @returns {Promise<any>} A promise that resolves when the email is sent.
 */
const sendOtpEmail = async (userEmail, otpCode) => {
    const subject = 'Verify Your JGM Account - OTP';
    const html = `
        <div style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
            <h2>Welcome to JGM Industries!</h2>
            <p>Please use the following 6-digit code to verify your email address. This code will expire in 10 minutes.</p>
            <h1 style="background: #f4f4f4; padding: 10px; letter-spacing: 5px; color: #3498db;">${otpCode}</h1>
            <p>If you did not request this, please ignore this email.</p>
        </div>
    `;

    if (isProduction) {
        return sendViaBrevoAPI({ to: userEmail, subject, html });
    }

    // Local dev — use Gmail SMTP
    return localTransporter.sendMail({
        from: `"JGM Industries" <${getFromAddress()}>`,
        to: userEmail,
        subject,
        html
    });
};

/**
 * Dispatches a contact form message to the admin inbox.
 * @param {string} name - Sender's name.
 * @param {string} email - Sender's email (used as replyTo).
 * @param {string} subject - Message subject.
 * @param {string} message - Message body.
 * @returns {Promise<any>} A promise that resolves when the email is sent.
 */
const sendContactEmail = async (name, email, subject, message) => {
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeSubject = escapeHtml(subject);
    const safeMessage = escapeHtml(message);

    const fullSubject = `JGM Contact Form: ${safeSubject}`;
    const html = `
        <h3>New Message from JGM Industries Contact Form</h3>
        <p><strong>Name:</strong> ${safeName}</p>
        <p><strong>Email:</strong> ${safeEmail}</p>
        <p><strong>Subject:</strong> ${safeSubject}</p>
        <hr/>
        <p><strong>Message:</strong></p>
        <p>${safeMessage}</p>
    `;

    if (isProduction) {
        return sendViaBrevoAPI({
            to: process.env.EMAIL_USER,
            subject: fullSubject,
            html,
            replyTo: email
        });
    }

    // Local dev — use Gmail SMTP
    return localTransporter.sendMail({
        from: getFromAddress(),
        to: process.env.EMAIL_USER,
        replyTo: email,
        subject: fullSubject,
        html
    });
};

/**
 * Dispatches an HTML-formatted email containing the order invoice.
 * @param {string} userEmail - The recipient's email address.
 * @param {Object} order - The order object.
 * @returns {Promise<any>} A promise that resolves when the email is sent.
 */
const sendInvoiceEmail = async (userEmail, order) => {
    const subject = `Your Invoice for Order #${order.id}`;
    
    // Create items HTML
    const itemsHtml = order.orderItems.map(item => `
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(item.product?.name || 'Product')}</td>
            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantity}</td>
            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${(item.product?.price || 0).toLocaleString('en-IN')}</td>
            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${((item.product?.price || 0) * item.quantity).toLocaleString('en-IN')}</td>
        </tr>
    `).join('');

    const html = `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px;">
            <h2 style="color: #2c3e50; border-bottom: 2px solid #eee; padding-bottom: 10px;">JGM Industries</h2>
            <h3>Order Receipt / Invoice</h3>
            <div style="margin-bottom: 20px;">
                <p style="margin: 5px 0;"><strong>Order ID:</strong> ${order.id}</p>
                <p style="margin: 5px 0;"><strong>Date:</strong> ${new Date(order.dateOrdered).toLocaleDateString()}</p>
                <p style="margin: 5px 0;"><strong>Status:</strong> ${order.status}</p>
                <p style="margin: 5px 0;"><strong>Tracking Number:</strong> ${order.trackingNumber || 'N/A'}</p>
                <p style="margin: 5px 0;"><strong>Courier:</strong> ${order.courierName || 'N/A'}</p>
            </div>
            
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <thead>
                    <tr style="background-color: #f8f9fa;">
                        <th style="padding: 10px; text-align: left; border-bottom: 2px solid #ddd;">Item</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #ddd;">Qty</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #ddd;">Price</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #ddd;">Subtotal</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemsHtml}
                </tbody>
                <tfoot>
                    <tr>
                        <td colspan="3" style="text-align: right; padding: 15px 10px; font-weight: bold; border-top: 2px solid #ddd;">Total Amount:</td>
                        <td style="text-align: right; padding: 15px 10px; font-weight: bold; color: #2ecc71; border-top: 2px solid #ddd; font-size: 1.2em;">₹${(order.totalPrice || 0).toLocaleString('en-IN')}</td>
                    </tr>
                </tfoot>
            </table>
            
            <p style="color: #7f8c8d; font-size: 0.9em; text-align: center; margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px;">
                Thank you for your business!<br>
                For any questions regarding this invoice, please contact our support team.
            </p>
        </div>
    `;

    if (isProduction) {
        return sendViaBrevoAPI({ to: userEmail, subject, html });
    }

    // Local dev — use Gmail SMTP
    return localTransporter.sendMail({
        from: `"JGM Industries" <${getFromAddress()}>`,
        to: userEmail,
        subject,
        html
    });
};

module.exports = { sendOtpEmail, sendContactEmail, sendInvoiceEmail };
