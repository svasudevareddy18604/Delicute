// db.js
require('dotenv').config();
const mysql = require('mysql2/promise');

const useSSL = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, // ✅ matches your .env
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined, // usually off for local
});

// Optional: quick smoke test
(async () => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    console.log('[DB] OK:', rows[0]);
  } catch (e) {
    console.error('[DB] Connection failed:', e.message);
  }
})();

module.exports = pool;
