const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5
});

// An idle-connection error (Neon closes idle sockets) must not crash the process.
pool.on('error', (err) => console.error('Postgres pool error:', err.message));

module.exports = { pool };
