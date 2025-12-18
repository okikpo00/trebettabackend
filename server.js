// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const path = require('path');
const pool = require('./config/db');

// Start cron jobs
const { startCron } = require('./jobs/poolCronJobs');
startCron();

const { runManualDepositMatcher } = require('./services/manualDepositMatcher');

setInterval(() => {
  runManualDepositMatcher();
}, 5000); // every 5 seconds


const authRoutes = require('./routes/authRoutes');
const adminAuthRoutes = require('./routes/adminAuthRoutes');
const userRoutes = require('./routes/userRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const adminUserRoutes = require('./routes/adminUserRoutes');
const adminWalletRoutes = require('./routes/adminWalletRoutes');
const adminTransactionRoutes = require('./routes/adminTransactionRoutes');
const kycRoutes = require('./routes/kycRoutes');
const adminKycRoutes = require('./routes/adminKycRoutes');
const publicUiRoutes = require('./routes/publicUiRoutes');
const adminDepositRoutes = require('./routes/adminDepositRoutes');
const adminWithdrawRoutes = require('./routes/adminWithdrawRoutes');
const poolRoutes = require('./routes/poolRoutes');
const adminPoolRoutes = require('./routes/adminPoolRoutes');
const adminPoolOptionRoutes = require('./routes/adminPoolOptionRoutes');
const rolloverRoutes = require('./routes/rolloverRoutes');
const adminBillboardRoutes = require('./routes/adminBillboardRoutes');
const walletRoutes = require('./routes/walletRoutes'); // your wallet routes
const webhookController = require('./controllers/webhookController');
const homeRoutes = require('./routes/homeRoutes');
const adminDashboardRoutes = require('./routes/adminDashboardRoutes');
const userBillboardRoutes = require('./routes/userBillboardRoutes');
const winnerTickerRoutes = require('./routes/winnerTickerRoutes');
const adminWinnerRoutes = require('./routes/adminWinnerRoutes');
const slipRoutes = require('./routes/slipRoutes');
const adminSettingRoutes = require('./routes/adminSettingRoutes');
const adminProfileRoutes = require('./routes/adminProfileRoutes');
const adminSessionRoutes = require('./routes/adminSessionRoutes');
const { adminApiLimiter } = require('./middleware/rateLimiter');
const bankAlertRoutes = require('./routes/bankAlertRoutes');
const adminDepositMatchRoutes = require('./routes/adminDepositMatchRoutes');
const publicRoutes = require('./routes/publicRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const app = express();

// CORS config
const allowedOrigins = [
  "https://trebetta.com",
  "https://www.trebetta.com",
  "https://admin.trebetta.com",

  // Local development
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175"
]

// raw body saver (for webhook signature verification)
const rawBodySaver = (req, res, buf, encoding) => {
  if (buf && buf.length) req.rawBody = buf;
};
  

// --------------------------------------------
// RAW BODY FOR WEBHOOKS (MUST COME FIRST)
// --------------------------------------------
app.use('/webhook/flutterwave', bodyParser.raw({ type: '*/*' }));
app.use('/webhook/paystack', bodyParser.raw({ type: '*/*' }));


// Use single express.json with verify
app.use(express.json({ limit: '2mb', verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());



app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('CORS not allowed'));
    },
    credentials: true,
  })
);

// Root welcome
app.get('/', (req, res) => {
  res.json({ message: '✅ Trebetta API (backend) — running' });
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 + 1 AS result');
    res.json({ ok: true, db: 'up', result: rows[0].result });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'down', error: err.message });
  }
});
app.get('/flutterwave/redirect', (req, res) => {
  return res.send('Payment processing, you can close this page.');
});
app.post(
  '/api/webhooks/flutterwave',
  express.raw({ type: 'application/json' }),
  webhookController.flutterwaveWebhook
);

// mount routes (these are safe placeholders for now)
app.use('/api/auth', authRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/users', userRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/transactions', transactionRoutes);

app.use('/api/ui', publicUiRoutes); // public READ endpoints

app.use('/api/admin/users', adminUserRoutes);
app.use('/api/admin/wallets', adminWalletRoutes);
app.use('/api/admin/transactions', adminTransactionRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/admin/kyc', adminKycRoutes)
app.use('/api/admin/deposits', adminDepositRoutes);
app.use('/api/admin/withdraw', adminWithdrawRoutes); 
app.use('/api/pools', poolRoutes);
app.use('/api/admin/pools', adminPoolRoutes, );
app.use('/api/admin/pools/option', adminPoolOptionRoutes, );
app.use('/api/admin/rollover', rolloverRoutes, );
app.use('/api/admin/billboards', adminBillboardRoutes);
app.use('/api/winner-ticker', winnerTickerRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/billboard', userBillboardRoutes);
app.use("/api/winner-ticker", winnerTickerRoutes);
app.use("/api/admin/winner-ticker", adminWinnerRoutes);
app.use("/api/wallet",  walletRoutes);
app.use('/api/slip', slipRoutes);
app.use('/api/admin/sessions', adminSessionRoutes);
app.use('/api/admin', adminProfileRoutes);
app.use('/api/admin/settings', adminSettingRoutes);
app.use('/api/internal/bank', bankAlertRoutes);
app.use('/api/admin/deposits', adminDepositMatchRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/admin', adminApiLimiter);



// 404 handler (last)
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ message: 'Server error', error: err.message });
});



const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Trebetta API running on http://localhost:${PORT}`);
});

