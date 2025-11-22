import 'dotenv/config';
import express from 'express';

// Config via .env
const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'pokemon-tcg-api.p.rapidapi.com';
const API_BASE = process.env.API_BASE || `https://${RAPIDAPI_HOST}`;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 99);

// Example path to verify connectivity (replace with your sealed-products endpoint later)
// For now mirrors your snippet endpoint
const EPISODES_PATH = process.env.EPISODES_PATH || '/episodes';

const app = express();

// Simple CORS for local file:// or other dev origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/status', (req, res) => {
  res.json({ ok: true, host: RAPIDAPI_HOST, base: API_BASE, hasKey: Boolean(RAPIDAPI_KEY) });
});

// Minimal in-memory cache to protect quota
const cache = new Map(); // key -> { ts, ttlMs, data }
function getCache(key) {
  const ent = cache.get(key);
  if (!ent) return null;
  if (Date.now() - ent.ts > ent.ttlMs) { cache.delete(key); return null; }
  return ent.data;
}
function setCache(key, data, ttlMs = 1000 * 60 * 60) { // 1h default
  cache.set(key, { ts: Date.now(), ttlMs, data });
}

// Simple UTC daily quota (resets at 00:00 UTC)
let quotaState = { day: new Date().toISOString().slice(0, 10), used: 0 };
function nowDayUTC() { return new Date().toISOString().slice(0, 10); }
function resetQuotaIfNeeded() {
  const today = nowDayUTC();
  if (quotaState.day !== today) quotaState = { day: today, used: 0 };
}
function checkAndUseQuota() {
  resetQuotaIfNeeded();
  if (quotaState.used >= DAILY_LIMIT) return { allowed: false, remaining: 0, resetDay: quotaState.day };
  quotaState.used += 1;
  return { allowed: true, remaining: DAILY_LIMIT - quotaState.used, resetDay: quotaState.day };
}
function quotaExceeded(res) {
  resetQuotaIfNeeded();
  return res.status(429).json({
    error: 'Daily API quota reached',
    limit: DAILY_LIMIT,
    used: quotaState.used,
    remaining: Math.max(0, DAILY_LIMIT - quotaState.used),
    resetUtcDay: nowDayUTC()
  });
}

// Proxy for episodes (connectivity check)
app.get('/api/episodes', async (req, res) => {
  try {
    if (!RAPIDAPI_KEY) return res.status(500).json({ error: 'Missing RAPIDAPI_KEY in .env' });
    const qs = new URLSearchParams(req.query).toString();
    const url = `${API_BASE}${EPISODES_PATH}${qs ? `?${qs}` : ''}`;

    const cached = getCache(url);
    if (cached) return res.json(cached);

    const quota = checkAndUseQuota();
    if (!quota.allowed) return quotaExceeded(res);

    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      }
    });
    const text = await resp.text();
    // Try JSON when possible
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    setCache(url, data, 1000 * 60 * 60); // 1 hour
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Proxy error', details: String(err) });
  }
});

// Products endpoints
const PRODUCTS_PATH = process.env.PRODUCTS_PATH || '/products';
const PRODUCTS_SEARCH_PATH = process.env.PRODUCTS_SEARCH_PATH || '/products/search';

// List products (supports pass-through of query params like sort, page)
app.get('/api/products', async (req, res) => {
  try {
    if (!RAPIDAPI_KEY) return res.status(500).json({ error: 'Missing RAPIDAPI_KEY in .env' });
    const params = new URLSearchParams(req.query);
    if (!params.has('sort')) params.set('sort', 'episode_newest');
    const url = `${API_BASE}${PRODUCTS_PATH}?${params.toString()}`;
    const cached = getCache(url);
    if (cached) return res.json(cached);
    const quota = checkAndUseQuota();
    if (!quota.allowed) return quotaExceeded(res);
    const resp = await fetch(url, { headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } });
    const json = await resp.json();
    setCache(url, json, 1000 * 60 * 60);
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: 'Products proxy error', details: String(err) });
  }
});

// Search products: expects q param from client, maps to `search` for upstream
app.get('/api/products/search', async (req, res) => {
  try {
    if (!RAPIDAPI_KEY) return res.status(500).json({ error: 'Missing RAPIDAPI_KEY in .env' });
    const q = (req.query.q || '').toString();
    const params = new URLSearchParams();
    if (q) params.set('search', q);
    params.set('sort', (req.query.sort || 'episode_newest').toString());
    if (req.query.page) params.set('page', req.query.page.toString());
    if (req.query.limit) params.set('limit', req.query.limit.toString());
    const url = `${API_BASE}${PRODUCTS_SEARCH_PATH}?${params.toString()}`;
    const cached = getCache(url);
    if (cached) return res.json(cached);
    const quota = checkAndUseQuota();
    if (!quota.allowed) return quotaExceeded(res);
    const resp = await fetch(url, { headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } });
    const json = await resp.json();
    setCache(url, json, 1000 * 60 * 60);
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: 'Products search proxy error', details: String(err) });
  }
});

// Product detail by id
app.get('/api/products/:id', async (req, res) => {
  try {
    if (!RAPIDAPI_KEY) return res.status(500).json({ error: 'Missing RAPIDAPI_KEY in .env' });
    const id = req.params.id;
    const url = `${API_BASE}${PRODUCTS_PATH}/${encodeURIComponent(id)}`;
    const cached = getCache(url);
    if (cached) return res.json(cached);
    const quota = checkAndUseQuota();
    if (!quota.allowed) return quotaExceeded(res);
    const resp = await fetch(url, { headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } });
    const json = await resp.json();
    setCache(url, json, 1000 * 60 * 60);
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: 'Product detail proxy error', details: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`[proxy] listening on http://localhost:${PORT}`);
});
