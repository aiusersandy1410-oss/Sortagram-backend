const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const { pool } = require('./db');
const linkInfo = require('./linkinfo');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('JWT_SECRET is not set'); process.exit(1); }

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for per-IP rate limiting
app.use(express.json({ limit: '2mb' }));

// Auth is a bearer token (Authorization header), not a cookie, so no credentials mode is needed.
const origins = (process.env.CLIENT_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Server error' });
});

// ---------- database setup (idempotent; safe on an existing database) ----------
async function ensureSchema() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users (
       id SERIAL PRIMARY KEY, sync_code TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS topics (
       id TEXT NOT NULL, user_id INTEGER NOT NULL, name TEXT, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
       PRIMARY KEY (user_id, id))`,
    `CREATE TABLE IF NOT EXISTS items (
       id TEXT NOT NULL, user_id INTEGER NOT NULL, title TEXT, platform TEXT, url TEXT, thumb TEXT, notes TEXT,
       topic_ids JSONB DEFAULT '[]', created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
       PRIMARY KEY (user_id, id))`,
    `ALTER TABLE topics ADD COLUMN IF NOT EXISTS color_index INTEGER DEFAULT 0`,
    `ALTER TABLE topics ADD COLUMN IF NOT EXISTS is_creator BOOLEAN DEFAULT false`,
    `ALTER TABLE topics ADD COLUMN IF NOT EXISTS server_updated_at TIMESTAMPTZ DEFAULT now()`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS favorite BOOLEAN DEFAULT false`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS server_updated_at TIMESTAMPTZ DEFAULT now()`,
    // Older schemas had these columns as NOT NULL; the client no longer sends them.
    `ALTER TABLE topics ALTER COLUMN color DROP NOT NULL`,
    `ALTER TABLE topics ALTER COLUMN sort_order DROP NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ai_usage (
       user_id INTEGER NOT NULL, day DATE NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))`,
    `CREATE INDEX IF NOT EXISTS topics_user_sync ON topics (user_id, server_updated_at)`,
    `CREATE INDEX IF NOT EXISTS items_user_sync ON items (user_id, server_updated_at)`
  ];
  for (const s of stmts) {
    try { await pool.query(s); }
    catch (e) { console.warn('schema step skipped:', s.slice(0, 50).replace(/\s+/g, ' '), '-', e.message); }
  }
}

// ---------- helpers ----------
// The client sends epoch milliseconds; TIMESTAMPTZ columns reject those, so convert to ISO.
function toIso(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback === undefined ? null : fallback;
  const d = new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  if (isNaN(d.getTime())) return fallback === undefined ? null : fallback;
  return d.toISOString();
}
const str = (v, max) => (v == null ? '' : String(v).slice(0, max));

const WORDS = [
  'amber','birch','cedar','delta','ember','flint','glow','harbor','iris','jade',
  'kelp','lumen','maple','nova','opal','pine','quartz','river','slate','tide',
  'umber','violet','willow','xenon','yarrow','zephyr','coral','dune','frost','grove'
];
const word = () => WORDS[crypto.randomInt(WORDS.length)];
const digits = (n) => String(crypto.randomInt(10 ** n)).padStart(n, '0');
// Three words + 4 digits = ~270 million combinations (was ~9 million).
const generateSyncCode = () => `${word()}-${word()}-${word()}-${digits(4)}`;

// Simple in-memory limiter (single Render instance). Blocks code-guessing on /auth/join.
const attempts = new Map();
function limited(ip, max, windowMs) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.reset) { attempts.set(ip, { n: 1, reset: now + windowMs }); return false; }
  rec.n += 1;
  return rec.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (now > v.reset) attempts.delete(k); }, 600000).unref();

const issueToken = (userId) => jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '365d' });

function requireAuth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m) return res.status(401).json({ error: 'Not authenticated' });
  try { req.userId = jwt.verify(m[1], JWT_SECRET).uid; next(); }
  catch { res.status(401).json({ error: 'Session expired' }); }
}

// ---------- routes ----------
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/auth/start', wrap(async (req, res) => {
  if (limited('start:' + req.ip, 20, 3600000)) return res.status(429).json({ error: 'Too many attempts, try again later' });
  let code, user;
  for (let i = 0; i < 3 && !user; i++) {
    code = generateSyncCode();
    try {
      const { rows } = await pool.query('INSERT INTO users (sync_code) VALUES ($1) RETURNING id', [code]);
      user = rows[0];
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  if (!user) return res.status(500).json({ error: 'Could not generate a unique code, try again' });
  res.json({ syncCode: code, token: issueToken(user.id) });
}));

app.post('/auth/join', wrap(async (req, res) => {
  if (limited('join:' + req.ip, 10, 900000)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
  const code = String(req.body.syncCode || '').trim().toLowerCase();
  if (!code) return res.status(400).json({ error: 'Enter a sync code' });
  const { rows } = await pool.query('SELECT id FROM users WHERE sync_code = $1', [code]);
  if (!rows[0]) return res.status(404).json({ error: 'That code was not found' });
  res.json({ syncCode: code, token: issueToken(rows[0].id) });
}));

app.get('/auth/me', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT sync_code AS "syncCode" FROM users WHERE id = $1', [req.userId]);
  if (!rows[0]) return res.status(401).json({ error: 'Account not found' });
  res.json({ user: rows[0] });
}));

const TOPIC_COLS = `id, name, color_index AS "colorIndex", is_creator AS "isCreator",
  updated_at AS "updatedAt", deleted_at AS "deletedAt"`;
const ITEM_COLS = `id, title, platform, url, thumb, notes, topic_ids AS "topicIds", favorite,
  created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"`;

// Pull. Filters on the SERVER's own write time (not the client-supplied updatedAt), so a device
// with a wrong clock can't hide its changes from other devices. 10s overlap is harmless: merging is idempotent.
app.get('/api/sync', requireAuth, wrap(async (req, res) => {
  const since = toIso(req.query.since, '1970-01-01T00:00:00Z');
  const { rows: [{ now }] } = await pool.query('SELECT now() AS now');
  const q = (cols, table) => pool.query(
    `SELECT ${cols} FROM ${table} WHERE user_id = $1 AND server_updated_at > ($2::timestamptz - interval '10 seconds')`,
    [req.userId, since]);
  const [topics, items] = await Promise.all([q(TOPIC_COLS, 'topics'), q(ITEM_COLS, 'items')]);
  res.json({ topics: topics.rows, items: items.rows, syncedAt: new Date(now).toISOString() });
}));

// Push. Last-write-wins on the client's updatedAt, decided atomically inside the upsert.
// Records the server rejects (its copy is newer) are returned in full so the client can adopt them.
app.post('/api/sync', requireAuth, wrap(async (req, res) => {
  const topics = Array.isArray(req.body.topics) ? req.body.topics.slice(0, 500) : [];
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 500) : [];
  const rejected = { topics: [], items: [] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of topics) {
      if (!t || !t.id) continue;
      const { rowCount } = await client.query(
        `INSERT INTO topics (id, user_id, name, color_index, is_creator, updated_at, deleted_at, server_updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, clock_timestamp())
         ON CONFLICT (user_id, id) DO UPDATE
           SET name=EXCLUDED.name, color_index=EXCLUDED.color_index, is_creator=EXCLUDED.is_creator,
               updated_at=EXCLUDED.updated_at, deleted_at=EXCLUDED.deleted_at, server_updated_at=clock_timestamp()
           WHERE topics.updated_at IS NULL OR topics.updated_at <= EXCLUDED.updated_at`,
        [str(t.id, 100), req.userId, str(t.name, 60), Number(t.colorIndex) || 0, !!t.isCreator,
         toIso(t.updatedAt, new Date().toISOString()), toIso(t.deletedAt)]);
      if (!rowCount) rejected.topics.push(str(t.id, 100));
    }
    for (const i of items) {
      if (!i || !i.id) continue;
      const { rowCount } = await client.query(
        `INSERT INTO items (id, user_id, title, platform, url, thumb, notes, topic_ids, favorite,
                            created_at, updated_at, deleted_at, server_updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, clock_timestamp())
         ON CONFLICT (user_id, id) DO UPDATE
           SET title=EXCLUDED.title, platform=EXCLUDED.platform, url=EXCLUDED.url, thumb=EXCLUDED.thumb,
               notes=EXCLUDED.notes, topic_ids=EXCLUDED.topic_ids, favorite=EXCLUDED.favorite,
               updated_at=EXCLUDED.updated_at, deleted_at=EXCLUDED.deleted_at, server_updated_at=clock_timestamp()
           WHERE items.updated_at IS NULL OR items.updated_at <= EXCLUDED.updated_at`,
        [str(i.id, 100), req.userId, str(i.title, 300), str(i.platform, 30) || 'other', str(i.url, 2000),
         str(i.thumb, 2000), str(i.notes, 2000), JSON.stringify(Array.isArray(i.topicIds) ? i.topicIds : []),
         !!i.favorite, toIso(i.createdAt, new Date().toISOString()),
         toIso(i.updatedAt, new Date().toISOString()), toIso(i.deletedAt)]);
      if (!rowCount) rejected.items.push(str(i.id, 100));
    }
    await client.query('COMMIT');

    const current = { topics: [], items: [] };
    if (rejected.topics.length) current.topics = (await pool.query(
      `SELECT ${TOPIC_COLS} FROM topics WHERE user_id=$1 AND id = ANY($2)`, [req.userId, rejected.topics])).rows;
    if (rejected.items.length) current.items = (await pool.query(
      `SELECT ${ITEM_COLS} FROM items WHERE user_id=$1 AND id = ANY($2)`, [req.userId, rejected.items])).rows;
    res.json({ ok: true, rejected, current, syncedAt: new Date().toISOString() });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// ---------- link auto-fill (Gemini) ----------
// Needs GEMINI_API_KEY on Render. The key never leaves the server.
// gemini-2.5-flash was retired on 16 Oct 2026. Set GEMINI_MODEL on Render to change the first choice;
// if a model is gone the server automatically tries the next one.
const GEMINI_MODELS = [process.env.GEMINI_MODEL || 'gemini-3.5-flash', 'gemini-3-flash-preview']
  .filter((m, i, a) => m && a.indexOf(m) === i);
let aiClient = null;
async function getAi() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!aiClient) {
    const { GoogleGenAI } = await import('@google/genai'); // ESM-only package, loaded from CommonJS
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return aiClient;
}

// ---- daily allowance (stored in Postgres, so reloading the page or a server restart can't reset it) ----
// Counts links read per user per UTC day. Set AI_DAILY_LIMIT on Render to change it.
const AI_DAILY_LIMIT = Math.max(1, parseInt(process.env.AI_DAILY_LIMIT, 10) || 200);
const TODAY = "(now() AT TIME ZONE 'UTC')::date";

async function aiUsed(userId) {
  try {
    const { rows } = await pool.query(`SELECT n FROM ai_usage WHERE user_id = $1 AND day = ${TODAY}`, [userId]);
    return rows[0] ? rows[0].n : 0;
  } catch (e) { console.warn('ai_usage read failed:', e.message); return 0; }
}
// Reserves `count` links atomically; false when that would pass the daily limit. Fails open if the table is unavailable.
async function aiConsume(userId, count) {
  if (count > AI_DAILY_LIMIT) return false;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO ai_usage (user_id, day, n) VALUES ($1, ${TODAY}, $2)
       ON CONFLICT (user_id, day) DO UPDATE SET n = ai_usage.n + EXCLUDED.n
       WHERE ai_usage.n + EXCLUDED.n <= $3`, [userId, count, AI_DAILY_LIMIT]);
    return rowCount === 1;
  } catch (e) { console.warn('ai_usage write failed (allowing):', e.message); return true; }
}
async function aiRefund(userId, count) {
  try { await pool.query(`UPDATE ai_usage SET n = GREATEST(n - $2, 0) WHERE user_id = $1 AND day = ${TODAY}`, [userId, count]); }
  catch (e) { /* best effort */ }
}
const limitReply = (res, msg) => res.status(429).json({ code: 'limit', error: msg });
const isGeminiLimit = (e) => e && (e.status === 429 || /\b429\b|RESOURCE_EXHAUSTED/.test(String(e.message || '')));
const cleanTopicNames = (list) => (Array.isArray(list) ? list : [])
  .filter((t) => typeof t === 'string').map((t) => t.trim().slice(0, 30)).filter(Boolean).slice(0, 100);

// Lets the app know up front whether auto-fill is available, so it can show the manual form straight away.
app.get('/api/ai-status', requireAuth, wrap(async (req, res) => {
  const used = await aiUsed(req.userId);
  res.json({ enabled: !!process.env.GEMINI_API_KEY, used, limit: AI_DAILY_LIMIT, remaining: Math.max(0, AI_DAILY_LIMIT - used) });
}));

// One link (used when saving a single item).
app.post('/api/link-info', requireAuth, wrap(async (req, res) => {
  const url = linkInfo.validateUrl(req.body.url);
  if (!url) return res.status(400).json({ error: 'That doesn\u2019t look like a web link' });
  const ai = await getAi();
  if (!ai) return res.status(503).json({ code: 'unavailable', error: 'Link auto-fill isn\u2019t set up on the server yet' });
  if (!(await aiConsume(req.userId, 1))) return limitReply(res, 'Today\u2019s auto-fill limit is reached. It resets at midnight UTC.');
  try {
    const data = await linkInfo.analyzeWithModels({ ai, models: GEMINI_MODELS, url, existingTopics: cleanTopicNames(req.body.existingTopics) });
    if (!data) return res.json({ ok: false, reason: 'unreadable' });
    res.json({ ok: true, data });
  } catch (e) {
    await aiRefund(req.userId, 1);
    if (isGeminiLimit(e)) return limitReply(res, 'Gemini\u2019s limit was reached for now. Try again later.');
    console.error('link-info failed:', e && e.status, e && e.message);
    res.json({ ok: false, reason: 'error', hint: linkInfo.describeError(e) });
  }
}));

// Several links in one go (used by "Auto-sort with AI"): up to 10 per request.
app.post('/api/link-info/batch', requireAuth, wrap(async (req, res) => {
  const rawUrls = Array.isArray(req.body.urls) ? req.body.urls : [];
  const urls = rawUrls.map((u) => linkInfo.validateUrl(u));
  if (!urls.length || urls.length > 10 || urls.some((u) => !u)) return res.status(400).json({ error: 'Send between 1 and 10 valid web links' });
  const ai = await getAi();
  if (!ai) return res.status(503).json({ code: 'unavailable', error: 'Link auto-fill isn\u2019t set up on the server yet' });
  if (!(await aiConsume(req.userId, urls.length))) return limitReply(res, 'Today\u2019s auto-fill limit is reached. It resets at midnight UTC.');
  try {
    const results = await linkInfo.analyzeBatchWithModels({ ai, models: GEMINI_MODELS, urls, existingTopics: cleanTopicNames(req.body.existingTopics) });
    const unreadable = results.filter((r) => !r).length;
    if (unreadable) await aiRefund(req.userId, unreadable); // pages Gemini couldn't read don't use up the allowance
    res.json({ ok: true, results: results.map((data, i) => (data ? { url: rawUrls[i], ok: true, data } : { url: rawUrls[i], ok: false })) });
  } catch (e) {
    await aiRefund(req.userId, urls.length);
    if (isGeminiLimit(e)) return limitReply(res, 'Gemini\u2019s limit was reached for now. Try again later.');
    console.error('link-info batch failed:', e && e.status, e && e.message);
    res.json({ ok: false, reason: 'error', hint: linkInfo.describeError(e) });
  }
}));

const port = process.env.PORT || 3001;
ensureSchema().then(() => app.listen(port, () => console.log(`Sortagram sync server on :${port}`)));
