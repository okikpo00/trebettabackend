// utils/sendEmail.js
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 465,
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER, // e.g. your company noreply email
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send email with dynamic subject, HTML, and fallback text
 * @param {string} to - recipient email
 * @param {string} subject - email subject
 * @param {string} html - HTML body
 * @param {string} [text] - optional plain text fallback
 */
async function sendEmail(to, subject, html, text = "") {
  try {
    const mailOptions = {
      from: process.env.MAIL_FROM || `"Trebetta" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
      text,
    };

    await transporter.sendMail(mailOptions);
    console.log(`📧 Email sent to ${to}: ${subject}`);
  } catch (error) {
    console.error("❌ Email send error:", error.message);
  }
}

module.exports = sendEmail;
