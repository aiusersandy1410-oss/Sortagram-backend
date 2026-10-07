const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const { pool } = require('./db');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN }));

const JWT_SECRET = process.env.JWT_SECRET;

// ---------- sync-code auth (no third-party login) ----------
// Auth is a bearer JWT returned in the response body and sent back as
// `Authorization: Bearer <token>` — never a cookie. The frontend and
// backend live on different domains, and mobile in-app browsers (notably
// Instagram's) routinely block cross-site cookies without warning, which
// would silently break sessions. A token the client controls explicitly
// sidesteps that entirely. See sync.js's `api()` helper for the client side.

const WORDS = [
  'amber','birch','cedar','delta','ember','flint','glow','harbor','iris','jade',
  'kelp','lumen','maple','nova','opal','pine','quartz','river','slate','tide',
  'umber','violet','willow','xenon','yarrow','zephyr','coral','dune','frost','grove'
];
function randomWord(){ return WORDS[crypto.randomInt(WORDS.length)]; }
function randomDigits(n){ return String(crypto.randomInt(10 ** n)).padStart(n, '0'); }
function generateSyncCode(){
  return `${randomWord()}-${randomWord()}-${randomDigits(4)}`;
}

function issueToken(userId){
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '365d' });
}

// Converts an epoch-millisecond number (what the client's Date.now() produces)
// into an ISO string Postgres will accept for a TIMESTAMPTZ column. Binding
// the raw number directly fails with "invalid input syntax for type
// timestamp with time zone" — pg does not coerce bare numbers for you.
// null/undefined pass through as null (e.g. an item that was never deleted).
function toTimestamp(ms){
  if (ms === null || ms === undefined || ms === '') return null;
  const d = new Date(Number(ms));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Starts sync on this device: creates a brand-new account and its sync code.
// The person must save this code themselves to link another device — there's
// no email or password to recover it with, by design.
app.post('/auth/start', async (req, res) => {
  try {
    let code, inserted;
    // Extremely unlikely to collide, but retry once if it does.
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      code = generateSyncCode();
      try {
        const { rows } = await pool.query(
          `INSERT INTO users (sync_code) VALUES ($1) RETURNING id`,
          [code]
        );
        inserted = rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e; // unique_violation -> retry with a new code
      }
    }
    if (!inserted) return res.status(500).json({ error: 'Could not generate a unique code, try again' });
    res.json({ syncCode: code, token: issueToken(inserted.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start sync' });
  }
});

// Links this device to an existing account using a code generated elsewhere.
app.post('/auth/join', async (req, res) => {
  try {
    const code = (req.body.syncCode || '').trim().toLowerCase();
    if (!code) return res.status(400).json({ error: 'Enter a sync code' });
    const { rows } = await pool.query(`SELECT id FROM users WHERE sync_code = $1`, [code]);
    if (!rows[0]) return res.status(404).json({ error: 'That code was not found' });
    res.json({ syncCode: code, token: issueToken(rows[0].id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not join sync' });
  }
});

// JWTs here are stateless (no server-side session row to revoke), so there is
// nothing to invalidate on this end. Kept as a no-op endpoint in case a future
// client calls it; today's sync.js just drops the local token and never hits this.
app.post('/auth/logout', (req, res) => {
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).uid;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}

// Lets the client resume a session on page load and re-display the sync code
// (e.g. so "Manage sync" can show it again without the person re-copying it).
app.get('/auth/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT sync_code AS "syncCode" FROM users WHERE id = $1`, [req.userId]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ user: rows[0] });
});

// ---------- sync ----------
// Pull: everything changed since `since` (ISO timestamp, or omit for full sync)
app.get('/api/sync', requireAuth, async (req, res) => {
  const since = req.query.since || '1970-01-01T00:00:00Z';
  const topics = await pool.query(
    `SELECT id, name, color_index AS "colorIndex", is_creator AS "isCreator",
            updated_at AS "updatedAt", deleted_at AS "deletedAt"
     FROM topics WHERE user_id = $1 AND updated_at > $2`,
    [req.userId, since]
  );
  const items = await pool.query(
    `SELECT id, title, platform, url, thumb, notes, topic_ids AS "topicIds",
            created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"
     FROM items WHERE user_id = $1 AND updated_at > $2`,
    [req.userId, since]
  );
  res.json({ topics: topics.rows, items: items.rows, syncedAt: new Date().toISOString() });
});

// Push: client sends changed topics/items since its last sync.
// Last-write-wins: a record is only rejected if the server's copy is strictly newer.
app.post('/api/sync', requireAuth, async (req, res) => {
  const { topics = [], items = [] } = req.body;
  const rejected = { topics: [], items: [] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const t of topics) {
      // Guard against malformed queued records (e.g. a pre-migration record
      // missing a name) — one bad row shouldn't 500 the whole batch and
      // leave every other pending change permanently stuck retrying.
      if (!t || !t.id || !t.name) { rejected.topics.push(t && t.id); continue; }
      const { rows } = await client.query(
        `SELECT updated_at FROM topics WHERE user_id = $1 AND id = $2`,
        [req.userId, t.id]
      );
      if (rows[0] && new Date(rows[0].updated_at) > new Date(t.updatedAt)) {
        rejected.topics.push(t.id);
        continue;
      }
      await client.query(
        `INSERT INTO topics (id, user_id, name, color_index, is_creator, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, id) DO UPDATE
           SET name=$3, color_index=$4, is_creator=$5, updated_at=$6, deleted_at=$7`,
        [t.id, req.userId, t.name, t.colorIndex, !!t.isCreator, toTimestamp(t.updatedAt), toTimestamp(t.deletedAt)]
      );
    }

    for (const i of items) {
      if (!i || !i.id) { rejected.items.push(i && i.id); continue; }
      const { rows } = await client.query(
        `SELECT updated_at FROM items WHERE user_id = $1 AND id = $2`,
        [req.userId, i.id]
      );
      if (rows[0] && new Date(rows[0].updated_at) > new Date(i.updatedAt)) {
        rejected.items.push(i.id);
        continue;
      }
      await client.query(
        `INSERT INTO items (id, user_id, title, platform, url, thumb, notes, topic_ids, created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, id) DO UPDATE
           SET title=$3, platform=$4, url=$5, thumb=$6, notes=$7, topic_ids=$8, updated_at=$10, deleted_at=$11`,
        [i.id, req.userId, i.title, i.platform, i.url, i.thumb, i.notes,
         JSON.stringify(i.topicIds || []), toTimestamp(i.createdAt), toTimestamp(i.updatedAt), toTimestamp(i.deletedAt)]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, rejected, syncedAt: new Date().toISOString() });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Sync failed' });
  } finally {
    client.release();
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Stashboard sync server on :${port}`));
