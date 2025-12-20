const nodemailer = require('nodemailer');

let transporter = null;

/**
 * ---------------------------------------------------------
 * Get SMTP transporter (lazy init, production-safe)
 * ---------------------------------------------------------
 */
function getTransporter() {
  // Reuse existing transporter if already created
  if (transporter) return transporter;

  const host = process.env.MAIL_HOST;
  const port = Number(process.env.MAIL_PORT);
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;

  // Validate env configuration at runtime
  if (!host || !port || !user || !pass) {
    console.warn('⚠️ Email not configured properly (MAIL_* env missing)');
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true only for 465, false for 587 (Brevo)
    auth: {
      user,
      pass
    },
    pool: true,          // production-safe pooling
    maxConnections: 5,
    maxMessages: 100
  });

  return transporter;
}

/**
 * ---------------------------------------------------------
 * SEND EMAIL (Transactional)
 *
 * @param {string} to      Recipient email
 * @param {string} subject Email subject
 * @param {string} html    HTML body
 * @param {string} [text]  Optional plain-text fallback
 * ---------------------------------------------------------
 */
async function sendEmail(to, subject, html, text = '') {
  try {
    if (!to) {
      console.warn('⚠️ sendEmail skipped: recipient missing');
      return;
    }

    const mailer = getTransporter();
    if (!mailer) return; // Email not configured, fail silently

    const from =
      process.env.MAIL_FROM ||
      `Trebetta <${process.env.MAIL_USER}>`;

    const mailOptions = {
      from,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, '') // auto text fallback
    };

    const info = await mailer.sendMail(mailOptions);

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
