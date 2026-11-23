const express = require('express'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), path = require('path'), db = require('./db');
const prod = process.env.NODE_ENV === 'production';
const SECRET = process.env.JWT_SECRET || 'dev-only-secret';
if (prod && !process.env.JWT_SECRET) throw new Error('Set JWT_SECRET in production');

const app = express();
app.disable('x-powered-by'); app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
// Express 5 may leave req.body undefined when no JSON body was sent.
// Normalise it so validation returns a client error rather than a TypeError/500.
app.use((req, res, next) => { req.body ??= {}; next(); });
app.use(express.static(path.join(__dirname, 'public')));

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hits = new Map();
const MAX_RATE_LIMIT_IPS = 5000;
const limit = (req, res, next) => {
  const now = Date.now(), ip = req.ip;
  // Bound the map even if clients rotate source IPs; prune expired buckets
  // before admitting a new key once the cap is reached.
  if (!hits.has(ip) && hits.size >= MAX_RATE_LIMIT_IPS) {
    for (const [key, timestamps] of hits) {
      const recent = timestamps.filter(time => now - time < 6e4);
      if (recent.length) hits.set(key, recent);
      else hits.delete(key);
    }
    if (hits.size >= MAX_RATE_LIMIT_IPS) return next(bad('Too many attempts. Try again later.', 429));
  }
  const attempts = (hits.get(ip) || []).filter(time => now - time < 6e4);
  attempts.push(now);
  hits.set(ip, attempts);
  next(attempts.length > 20 ? bad('Too many attempts. Try again in a minute.', 429) : undefined);
};

// ---------- auth ----------
const setCookie = (res, u) => res.cookie('t', jwt.sign({ uid: u.id }, SECRET, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 7 * 864e5 });
const auth = (req, res, next) => {
  const m = (req.headers.cookie || '').match(/(?:^|; )t=([^;]+)/); let u;
  try { u = db.prepare('SELECT u.id,u.email,u.org_id,o.name org FROM users u JOIN orgs o ON o.id=u.org_id WHERE u.id=?').get(jwt.verify(m && m[1], SECRET).uid); } catch {}
  if (!u) return next(bad('Not authenticated', 401));
  req.u = u; next();
};

app.post('/api/auth/signup', limit, (req, res) => {
  const e = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || ''), org = String(req.body.orgName || '').trim();
  if (!EMAIL.test(e)) throw bad('Enter a valid email address');
  if (pw.length < 8) throw bad('Password must be at least 8 characters');
  if (!org) throw bad('Organization name is required');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(e)) throw bad('That email is already registered', 409);
  const u = db.transaction(() => {
    const oid = db.prepare('INSERT INTO orgs(name) VALUES(?)').run(org.slice(0, 80)).lastInsertRowid;
    const id = db.prepare('INSERT INTO users(org_id,email,password_hash) VALUES(?,?,?)').run(oid, e, bcrypt.hashSync(pw, 10)).lastInsertRowid;
    return { id };
  })();
  setCookie(res, u); res.status(201).json({ ok: true });
});
app.post('/api/auth/login', limit, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) throw bad('Invalid email or password', 401);
  setCookie(res, u); res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('t'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ email: req.u.email, org: req.u.org }));

// ---------- helpers ----------
const COLS = 'id,name,sku,description,quantity,cost_price,selling_price,low_stock_threshold,last_updated_by,created_at,updated_at';
const defThr = oid => db.prepare('SELECT default_threshold d FROM orgs WHERE id=?').get(oid).d;
const withLow = (p, d) => { const t = p.low_stock_threshold ?? d; return { ...p, threshold_used: t, is_low: p.quantity <= t }; };
const get = (oid, id) => { const p = db.prepare(`SELECT ${COLS} FROM products WHERE id=? AND org_id=?`).get(id, oid); return p && withLow(p, defThr(oid)); };
const logEv = (oid, pid, delta, note) => delta && db.prepare('INSERT INTO stock_events(org_id,product_id,delta,note) VALUES(?,?,?,?)').run(oid, pid, delta, note || null);
const num = (v, label, int) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n)) || n > 1e9) throw bad(`${label} must be ${int ? 'a whole number' : 'a number'} of 0 or more`);
  return n;
};
const clean = b => {
  const name = String(b.name || '').trim().slice(0, 120), sku = String(b.sku || '').trim().toUpperCase().slice(0, 60);
  if (!name) throw bad('Name is required'); if (!sku) throw bad('SKU is required');
  return { name, sku, description: String(b.description || '').trim().slice(0, 500) || null, quantity: num(b.quantity, 'Quantity', true) ?? 0,
    cost_price: num(b.cost_price, 'Cost price'), selling_price: num(b.selling_price, 'Selling price'), low_stock_threshold: num(b.low_stock_threshold, 'Low-stock threshold', true) };
};

// ---------- products (every query is scoped by org_id) ----------
app.get('/api/products', auth, (req, res) => {
  const d = defThr(req.u.org_id);
  res.json(db.prepare(`SELECT ${COLS} FROM products WHERE org_id=? ORDER BY name COLLATE NOCASE`).all(req.u.org_id).map(p => withLow(p, d)));
});
app.get('/api/products/:id', auth, (req, res) => { const p = get(req.u.org_id, req.params.id); if (!p) throw bad('Product not found', 404); res.json(p); });
app.post('/api/products', auth, (req, res) => {
  const p = clean(req.body), oid = req.u.org_id;
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO products(org_id,name,sku,description,quantity,cost_price,selling_price,low_stock_threshold,last_updated_by) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(oid, p.name, p.sku, p.description, p.quantity, p.cost_price, p.selling_price, p.low_stock_threshold, req.u.email);
    logEv(oid, r.lastInsertRowid, p.quantity, 'Initial stock'); return r.lastInsertRowid;
  })();
  res.status(201).json(get(oid, id));
});
app.put('/api/products/:id', auth, (req, res) => {
  const oid = req.u.org_id;
  const updated = db.transaction(() => {
    const old = get(oid, req.params.id);
    if (!old) throw bad('Product not found', 404);
    // PUT accepts partial fields for compatibility with API clients; omitted
    // values remain unchanged instead of being reset to defaults.
    const p = clean({ ...old, ...req.body });
    db.prepare('UPDATE products SET name=?,sku=?,description=?,quantity=?,cost_price=?,selling_price=?,low_stock_threshold=?,last_updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND org_id=?')
      .run(p.name, p.sku, p.description, p.quantity, p.cost_price, p.selling_price, p.low_stock_threshold, req.u.email, old.id, oid);
    logEv(oid, old.id, p.quantity - old.quantity, 'Edited');
    return get(oid, old.id);
  })();
  res.json(updated);
});
app.post('/api/products/:id/adjust', auth, (req, res) => {
  const oid = req.u.org_id;
  const updated = db.transaction(() => {
    const p = get(oid, req.params.id);
    if (!p) throw bad('Product not found', 404);
    const d = Number(req.body.delta);
    if (!Number.isInteger(d) || d === 0) throw bad('Enter a non-zero whole number');
    if (p.quantity + d < 0) throw bad(`Only ${p.quantity} in stock. Stock cannot go below zero.`);
    db.prepare('UPDATE products SET quantity=quantity+?,last_updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND org_id=?').run(d, req.u.email, p.id, oid);
    logEv(oid, p.id, d, String(req.body.note || '').slice(0, 200) || 'Adjustment');
    return get(oid, p.id);
  })();
  res.json(updated);
});
app.delete('/api/products/:id', auth, (req, res) => {
  const oid = req.u.org_id, p = get(oid, req.params.id); if (!p) throw bad('Product not found', 404);
  db.transaction(() => { logEv(oid, p.id, -p.quantity, 'Deleted'); db.prepare('DELETE FROM products WHERE id=? AND org_id=?').run(p.id, oid); })();
  res.json({ ok: true });
});

// ---------- settings ----------
app.get('/api/settings', auth, (req, res) => res.json({ default_threshold: defThr(req.u.org_id) }));
app.put('/api/settings', auth, (req, res) => {
  const n = num(req.body.default_threshold, 'Default threshold', true); if (n == null) throw bad('Default threshold is required');
  db.prepare('UPDATE orgs SET default_threshold=? WHERE id=?').run(n, req.u.org_id); res.json({ default_threshold: n });
});

// ---------- dashboard ----------
app.get('/api/dashboard', auth, (req, res) => {
  const oid = req.u.org_id, d = defThr(oid);
  const ps = db.prepare(`SELECT ${COLS} FROM products WHERE org_id=?`).all(oid).map(p => withLow(p, d));
  const low = ps.filter(p => p.is_low).sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name));
  const out = ps.filter(p => p.quantity === 0).length;
  const rows = db.prepare('SELECT date(created_at) d, SUM(delta) s FROM stock_events WHERE org_id=? GROUP BY d ORDER BY d').all(oid);
  const by = Object.fromEntries(rows.map(r => [r.d, r.s]));
  const days = [...Array(30)].map((_, i) => new Date(Date.now() - (29 - i) * 864e5).toISOString().slice(0, 10));
  // Hide the misleading pre-history zero run for newly-created organisations.
  // When history predates the window, carry its closing balance into day one.
  const firstEventDate = rows.length ? rows[0].d : null;
  const chartStart = firstEventDate && firstEventDate > days[0] ? firstEventDate : days[0];
  let run = rows.filter(r => r.d < chartStart).reduce((sum, r) => sum + r.s, 0);
  const trend = rows.length
    ? days.filter(date => date >= chartStart).map(date => ({ date, units: (run += by[date] || 0) }))
    : [];

  // Estimate days of cover from the last 30 calendar days of outbound stock
  // movements. It is deliberately null when there is no recorded outflow.
  const usageRows = db.prepare(`
    SELECT product_id,
      SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) units_out,
      MIN(date(created_at)) first_event_date,
      CAST(julianday(date('now')) - julianday(MIN(date(created_at))) + 1 AS INTEGER) observed_days
    FROM stock_events
    WHERE org_id=? AND date(created_at) >= date('now', '-29 days')
    GROUP BY product_id
  `).all(oid);
  const usageByProduct = new Map(usageRows.map(row => [row.product_id, row]));
  const lowWithCover = low.map(product => {
    const usage = usageByProduct.get(product.id);
    const unitsOut = usage?.units_out || 0;
    // Use the days actually observed for new products, capped at the 30-day window.
    const observedDays = usage ? Math.max(1, Math.min(30, usage.observed_days || 1)) : 0;
    const averageDailyOutflow = unitsOut > 0 ? unitsOut / observedDays : 0;
    const daysCover = averageDailyOutflow > 0 ? product.quantity / averageDailyOutflow : null;
    return { ...product, units_out_30d: unitsOut, observed_days: observedDays, days_cover: daysCover };
  });

  res.json({
    totalProducts: ps.length, totalUnits: ps.reduce((s, p) => s + p.quantity, 0), stockValue: ps.reduce((s, p) => s + p.quantity * (p.cost_price || 0), 0),
    lowCount: low.length, low: lowWithCover, health: { out, low: low.length - out, ok: ps.length - low.length },
    top: [...ps].sort((a, b) => b.quantity - a.quantity).slice(0, 8).map(p => ({ name: p.name, quantity: p.quantity, is_low: p.is_low })),
    trend
  });
});

app.use('/api', (req, res, next) => next(bad('Not found', 404)));
app.use((e, req, res, next) => {
  if (e.type === 'entity.parse.failed' || (e instanceof SyntaxError && e.status === 400 && 'body' in e)) {
    e = bad('Request body must contain valid JSON', 400);
  }
  if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const detail = String(e.message || '');
    if (detail.includes('users.email')) e = bad('That email is already registered', 409);
    else if (detail.includes('products.org_id') || detail.includes('products.sku')) e = bad('A product with that SKU already exists', 409);
    else e = bad('A record with those unique values already exists', 409);
  }
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' });
});

if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log('StockFlow on http://localhost:' + (process.env.PORT || 3000)));
module.exports = app;
