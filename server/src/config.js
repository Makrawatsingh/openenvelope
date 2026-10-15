import path from 'node:path';

const env = process.env;
export const config = {
  port: Number(env.PORT || 8787),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 8787}`).replace(/\/$/, ''),
  dataDir: env.DATA_DIR || path.resolve('data'),
  dbPath: env.DB_PATH || path.join(env.DATA_DIR || path.resolve('data'), 'openenvelope.db'),
  adminToken: env.ADMIN_TOKEN || '',
  allowSignup: env.ALLOW_SIGNUP === 'true',
  // Invite code: anyone who knows it can create an account from the extension (POST /api/users).
  signupCode: env.SIGNUP_CODE || '',
  signupRateLimit: Number(env.SIGNUP_RATE_LIMIT || 10), // signup attempts per IP per hour
  // How visitor IPs are stored: "hash" (default, salted SHA-256), "full", or "none".
  ipMode: env.IP_MODE || 'hash',
  ipSalt: env.IP_SALT || 'change-me-please',
  smtpUrl: env.SMTP_URL || '',          // e.g. smtps://you%40gmail.com:app-password@smtp.gmail.com:465
  smtpFrom: env.SMTP_FROM || '',
  schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 60_000),
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 25),
  corsOrigins: (env.CORS_ORIGINS || '*'),
};
