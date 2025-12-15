// utils/sendEmail.js
const nodemailer = require('nodemailer');

let transporter;

/**
 * Lazy-create transporter so app doesn't crash on boot
 * if email config is missing in some environments.
 */
function getTransporter() {
  if (transporter) return transporter;

  const {
    MAIL_HOST,
    MAIL_PORT,
    MAIL_USER,
    MAIL_PASS
  } = process.env;

  if (!MAIL_HOST || !MAIL_PORT || !MAIL_USER || !MAIL_PASS) {
    console.warn('⚠️ Email not configured properly (MAIL_* env missing)');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: MAIL_HOST,                 // smtp-relay.brevo.com
    port: Number(MAIL_PORT),          // 587
    secure: Number(MAIL_PORT) === 465, // false for 587, true for 465
    auth: {
      user: MAIL_USER,               // 9e0647001@smtp-brevo.com
      pass: MAIL_PASS                // Brevo SMTP password
    },
    pool: true,                      // production-safe
    maxConnections: 5,
    maxMessages: 100
  });

  return transporter;
}

/**
 * ---------------------------------------------------------
 * SEND EMAIL (Transactional)
 *
 * @param {string} to      - recipient email
 * @param {string} subject - email subject
 * @param {string} html    - HTML body
 * @param {string} [text] - optional plain text fallback
 * ---------------------------------------------------------
 */
async function sendEmail(to, subject, html, text = '') {
  try {
    if (!to) {
      console.warn('⚠️ sendEmail skipped: recipient missing');
      return;
    }

    const transporter = getTransporter();
    if (!transporter) return;

    const from =
      process.env.MAIL_FROM ||
      `Trebetta <${process.env.MAIL_USER}>`;

    const mailOptions = {
      from,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, '') // auto fallback
    };

    const info = await transporter.sendMail(mailOptions);

    console.log(`📧 Email sent → ${to} (${info.messageId})`);
  } catch (err) {
    console.error('❌ Email send failed:', {
      to,
      subject,
      error: err.message
    });
  }
}

module.exports = sendEmail;
