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
const auth = async (req, res, next) => {
  const m = (req.headers.cookie || '').match(/(?:^|; )t=([^;]+)/);
  let u;
  try {
    const payload = jwt.verify(m && m[1], SECRET);
    const { rows } = await db.query(
      'SELECT u.id, u.email, u.org_id, o.name AS org FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = $1',
      [payload.uid]
    );
    u = rows[0];
  } catch {}
  if (!u) return next(bad('Not authenticated', 401));
  req.u = u;
  next();
};

app.post('/api/auth/signup', limit, async (req, res) => {
  const e = String(req.body.email || '').trim().toLowerCase(),
    pw = String(req.body.password || ''),
    org = String(req.body.orgName || '').trim();
  if (!EMAIL.test(e)) throw bad('Enter a valid email address');
  if (pw.length < 8) throw bad('Password must be at least 8 characters');
  if (!org) throw bad('Organization name is required');

  const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [e]);
  if (existing.rows.length) throw bad('That email is already registered', 409);

  const client = await db.getClient();
  let u;
  try {
    await client.query('BEGIN');
    const orgRes = await client.query('INSERT INTO orgs(name) VALUES($1) RETURNING id', [org.slice(0, 80)]);
    const oid = orgRes.rows[0].id;
    const userRes = await client.query(
      'INSERT INTO users(org_id, email, password_hash) VALUES($1, $2, $3) RETURNING id',
      [oid, e, bcrypt.hashSync(pw, 10)]
    );
    u = { id: userRes.rows[0].id };
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  setCookie(res, u);
  res.status(201).json({ ok: true });
});

app.post('/api/auth/login', limit, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [String(req.body.email || '').trim().toLowerCase()]);
  const u = rows[0];
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) throw bad('Invalid email or password', 401);
  setCookie(res, u);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('t');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ email: req.u.email, org: req.u.org }));

// ---------- helpers ----------
const COLS = 'id,name,sku,description,quantity,cost_price,selling_price,low_stock_threshold,last_updated_by,created_at,updated_at';

const defThr = async (oid, client) => {
  const runner = client || db;
  const { rows } = await runner.query('SELECT default_threshold AS d FROM orgs WHERE id = $1', [oid]);
  return rows[0]?.d ?? 5;
};

const withLow = (p, d) => {
  const t = p.low_stock_threshold ?? d;
  return { ...p, threshold_used: t, is_low: p.quantity <= t };
};

const get = async (oid, id, client) => {
  const runner = client || db;
  const { rows } = await runner.query(`SELECT ${COLS} FROM products WHERE id = $1 AND org_id = $2`, [id, oid]);
  const p = rows[0];
  if (!p) return null;
  const d = await defThr(oid, client);
  return withLow(p, d);
};

const logEv = async (oid, pid, delta, note, client) => {
  if (!delta) return;
  const runner = client || db;
  await runner.query(
    'INSERT INTO stock_events(org_id, product_id, delta, note) VALUES($1, $2, $3, $4)',
    [oid, pid, delta, note || null]
  );
};

const num = (v, label, int) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n)) || n > 1e9) throw bad(`${label} must be ${int ? 'a whole number' : 'a number'} of 0 or more`);
  return n;
};

const clean = b => {
  const name = String(b.name || '').trim().slice(0, 120), sku = String(b.sku || '').trim().toUpperCase().slice(0, 60);
  if (!name) throw bad('Name is required'); if (!sku) throw bad('SKU is required');
  return {
    name,
    sku,
    description: String(b.description || '').trim().slice(0, 500) || null,
    quantity: num(b.quantity, 'Quantity', true) ?? 0,
    cost_price: num(b.cost_price, 'Cost price'),
    selling_price: num(b.selling_price, 'Selling price'),
    low_stock_threshold: num(b.low_stock_threshold, 'Low-stock threshold', true)
  };
};

// ---------- products (every query is scoped by org_id) ----------
app.get('/api/products', auth, async (req, res) => {
  const d = await defThr(req.u.org_id);
  const { rows } = await db.query(
    `SELECT ${COLS} FROM products WHERE org_id = $1 ORDER BY LOWER(name) ASC, id ASC`,
    [req.u.org_id]
  );
  res.json(rows.map(p => withLow(p, d)));
});

app.get('/api/products/:id', auth, async (req, res) => {
  const p = await get(req.u.org_id, req.params.id);
  if (!p) throw bad('Product not found', 404);
  res.json(p);
});

app.post('/api/products', auth, async (req, res) => {
  const p = clean(req.body), oid = req.u.org_id;
  const client = await db.getClient();
  let id;
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO products(org_id, name, sku, description, quantity, cost_price, selling_price, low_stock_threshold, last_updated_by)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [oid, p.name, p.sku, p.description, p.quantity, p.cost_price, p.selling_price, p.low_stock_threshold, req.u.email]
    );
    id = r.rows[0].id;
    await logEv(oid, id, p.quantity, 'Initial stock', client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const created = await get(oid, id);
  res.status(201).json(created);
});

app.put('/api/products/:id', auth, async (req, res) => {
  const oid = req.u.org_id;
  const client = await db.getClient();
  let updated;
  try {
    await client.query('BEGIN');
    const old = await get(oid, req.params.id, client);
    if (!old) throw bad('Product not found', 404);
    // PUT accepts partial fields for compatibility with API clients; omitted
    // values remain unchanged instead of being reset to defaults.
    const p = clean({ ...old, ...req.body });
    await client.query(
      `UPDATE products SET name = $1, sku = $2, description = $3, quantity = $4, cost_price = $5,
       selling_price = $6, low_stock_threshold = $7, last_updated_by = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 AND org_id = $10`,
      [p.name, p.sku, p.description, p.quantity, p.cost_price, p.selling_price, p.low_stock_threshold, req.u.email, old.id, oid]
    );
    await logEv(oid, old.id, p.quantity - old.quantity, 'Edited', client);
    updated = await get(oid, old.id, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json(updated);
});

app.post('/api/products/:id/adjust', auth, async (req, res) => {
  const oid = req.u.org_id;
  const client = await db.getClient();
  let updated;
  try {
    await client.query('BEGIN');
    const p = await get(oid, req.params.id, client);
    if (!p) throw bad('Product not found', 404);
    const d = Number(req.body.delta);
    if (!Number.isInteger(d) || d === 0) throw bad('Enter a non-zero whole number');
    if (p.quantity + d < 0) throw bad(`Only ${p.quantity} in stock. Stock cannot go below zero.`);
    await client.query(
      'UPDATE products SET quantity = quantity + $1, last_updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND org_id = $4',
      [d, req.u.email, p.id, oid]
    );
    await logEv(oid, p.id, d, String(req.body.note || '').slice(0, 200) || 'Adjustment', client);
    updated = await get(oid, p.id, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json(updated);
});

app.delete('/api/products/:id', auth, async (req, res) => {
  const oid = req.u.org_id;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const p = await get(oid, req.params.id, client);
    if (!p) throw bad('Product not found', 404);
    await logEv(oid, p.id, -p.quantity, 'Deleted', client);
    await client.query('DELETE FROM products WHERE id = $1 AND org_id = $2', [p.id, oid]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

// ---------- settings ----------
app.get('/api/settings', auth, async (req, res) => {
  const d = await defThr(req.u.org_id);
  res.json({ default_threshold: d });
});

app.put('/api/settings', auth, async (req, res) => {
  const n = num(req.body.default_threshold, 'Default threshold', true);
  if (n == null) throw bad('Default threshold is required');
  await db.query('UPDATE orgs SET default_threshold = $1 WHERE id = $2', [n, req.u.org_id]);
  res.json({ default_threshold: n });
});

// ---------- dashboard ----------
app.get('/api/dashboard', auth, async (req, res) => {
  const oid = req.u.org_id;
  const d = await defThr(oid);
  const productsRes = await db.query(`SELECT ${COLS} FROM products WHERE org_id = $1`, [oid]);
  const ps = productsRes.rows.map(p => withLow(p, d));
  const low = ps.filter(p => p.is_low).sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name));
  const out = ps.filter(p => p.quantity === 0).length;

  const rowsRes = await db.query(
    `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS d, SUM(delta)::int AS s
     FROM stock_events
     WHERE org_id = $1
     GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
     ORDER BY d`,
    [oid]
  );
  const rows = rowsRes.rows;
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
  const usageRes = await db.query(
    `SELECT product_id,
       SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END)::int AS units_out,
       MIN(TO_CHAR(created_at, 'YYYY-MM-DD')) AS first_event_date,
       (CURRENT_DATE - MIN(created_at::date) + 1)::int AS observed_days
     FROM stock_events
     WHERE org_id = $1 AND created_at >= (CURRENT_DATE - INTERVAL '29 days')
     GROUP BY product_id`,
    [oid]
  );
  const usageByProduct = new Map(usageRes.rows.map(row => [row.product_id, row]));
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
    totalProducts: ps.length,
    totalUnits: ps.reduce((s, p) => s + p.quantity, 0),
    stockValue: ps.reduce((s, p) => s + p.quantity * (p.cost_price || 0), 0),
    lowCount: low.length,
    low: lowWithCover,
    health: { out, low: low.length - out, ok: ps.length - low.length },
    top: [...ps].sort((a, b) => b.quantity - a.quantity).slice(0, 8).map(p => ({ name: p.name, quantity: p.quantity, is_low: p.is_low })),
    trend
  });
});

// ---------- insights: per-day item movements, sales analysis, forecast ----------
// PASTE THIS into server.js, just above the line:  app.use('/api', (req, res, next) => next(bad('Not found', 404)));
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const utcDay = d => new Date(d + 'T00:00:00Z');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const avg = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);

app.get('/api/insights', auth, async (req, res) => {
  const oid = req.u.org_id, since = dayKey(Date.now() - 29 * 864e5);
  const [dayItems, daySums, outs, prods, feedRows] = await Promise.all([
    // Top 5 items per day by size of movement, with opening and closing stock rebuilt from the event log.
    db.query(
      `WITH daily AS (
         SELECT product_id, TO_CHAR(created_at, 'YYYY-MM-DD') AS d, SUM(delta)::int AS change
         FROM stock_events WHERE org_id = $1 GROUP BY 1, 2
       ), bal AS (
         SELECT product_id, d, change, (SUM(change) OVER (PARTITION BY product_id ORDER BY d))::int AS close FROM daily
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY d ORDER BY ABS(change) DESC, product_id) AS rn FROM bal WHERE d >= $2
       )
       SELECT r.d, COALESCE(p.name, 'Deleted product') AS name, p.sku, (r.close - r.change) AS open, r.close, r.change
       FROM ranked r LEFT JOIN products p ON p.id = r.product_id AND p.org_id = $1
       WHERE r.rn <= 5 ORDER BY r.d, r.rn`,
      [oid, since]
    ),
    db.query(
      `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS d,
         COALESCE(SUM(-delta) FILTER (WHERE delta < 0 AND COALESCE(note, '') <> 'Deleted'), 0)::int AS sold,
         COALESCE(SUM(delta) FILTER (WHERE delta > 0), 0)::int AS received,
         COUNT(DISTINCT product_id)::int AS items, SUM(delta)::int AS net
       FROM stock_events WHERE org_id = $1 AND TO_CHAR(created_at, 'YYYY-MM-DD') >= $2 GROUP BY 1`,
      [oid, since]
    ),
    // Outbound units per product per day (deleting a product is not a sale).
    db.query(
      `SELECT product_id, TO_CHAR(created_at, 'YYYY-MM-DD') AS d, SUM(-delta)::int AS units
       FROM stock_events
       WHERE org_id = $1 AND delta < 0 AND COALESCE(note, '') <> 'Deleted' AND created_at >= CURRENT_DATE - INTERVAL '89 days'
       GROUP BY 1, 2`,
      [oid]
    ),
    db.query('SELECT id, name, quantity, cost_price, selling_price, low_stock_threshold FROM products WHERE org_id = $1', [oid]),
    // latest stock changes for the activity feed
    db.query(
      `SELECT e.id, e.delta, e.note, e.created_at, COALESCE(p.name, 'Deleted product') AS name
       FROM stock_events e LEFT JOIN products p ON p.id = e.product_id AND p.org_id = e.org_id
       WHERE e.org_id = $1 ORDER BY e.id DESC LIMIT 8`,
      [oid]
    )
  ]);


  // per-day table data
  const days = {};
  for (const r of daySums.rows) days[r.d] = { sold: r.sold, received: r.received, items: r.items, net: r.net, top: [] };
  for (const r of dayItems.rows) {
    (days[r.d] ??= { sold: 0, received: 0, items: 0, net: 0, top: [] })
      .top.push({ name: r.name, sku: r.sku, open: r.open, close: r.close, change: r.change });
  }

  // sales history
  const k90 = [...Array(90)].map((_, i) => dayKey(Date.now() - (89 - i) * 864e5));
  const k30 = k90.slice(60), prev30 = k90.slice(30, 60);
  const total = {}, byProduct = new Map();
  for (const r of outs.rows) {
    total[r.d] = (total[r.d] || 0) + r.units;
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, {});
    byProduct.get(r.product_id)[r.d] = r.units;
  }
  const sum = (o, ks) => ks.reduce((s, k) => s + (o[k] || 0), 0);
  const names = new Map(prods.rows.map(p => [p.id, p]));

  // analysis: most sold, not selling, busiest day
  const sellers = [...byProduct].filter(([id]) => names.has(id))
    .map(([id, o]) => ({ name: names.get(id).name, units: sum(o, k30) }))
    .filter(s => s.units > 0).sort((a, b) => b.units - a.units).slice(0, 3);
  const idle = prods.rows.filter(p => p.quantity > 0 && !sum(byProduct.get(p.id) || {}, k30))
    .sort((a, b) => b.quantity - a.quantity).slice(0, 3).map(p => ({ name: p.name, quantity: p.quantity }));
  const spark = k30.map(d => ({ date: d, units: total[d] || 0 }));
  const top = spark.reduce((m, s) => (s.units > m.units ? s : m), { units: 0 });
  const analysis = { sellers, idle, spark, peak: top.units ? top : null };

  // forecast: recent level + damped trend, shaped by day-of-week pattern
  const first = k90.find(d => total[d]);
  const history = first ? 90 - k90.indexOf(first) : 0;
  let forecast = { ready: false, history_days: history };
  if (history >= 14) {
    const series = k90.slice(90 - history).map(d => total[d] || 0);
    const level = avg(series.slice(-14)), before = series.slice(-28, -14);
    const slope = before.length ? (level - avg(before)) / 14 : 0;
    const wd = Array(7).fill(0), wn = Array(7).fill(0);
    series.forEach((u, i) => { const w = utcDay(k90[90 - history + i]).getUTCDay(); wd[w] += u; wn[w]++; });
    const mean = avg(series) || 1, useWeekdays = history >= 21;
    const idx = wd.map((s, i) => (useWeekdays && wn[i] >= 2 ? s / wn[i] / mean : 1));
    const fut = [...Array(30)].map((_, i) => {
      const t = new Date(Date.now() + (i + 1) * 864e5);
      return { t, u: Math.max(0, (level + 0.5 * slope * (i + 1)) * idx[t.getUTCDay()]) };
    });
    const label = t => t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const weeks = [0, 1, 2, 3].map(w => ({ label: label(fut[w * 7].t), units: Math.round(fut.slice(w * 7, w * 7 + 7).reduce((s, x) => s + x.u, 0)) }));
    const order = [...idx.keys()].sort((a, b) => idx[b] - idx[a]);
    const perProduct = [...byProduct].filter(([id]) => names.has(id)).map(([id, o]) => {
      const now = sum(o, k30), prev = sum(o, prev30);
      return { name: names.get(id).name, now, next: prev ? Math.max(0, Math.round(now + (now - prev) * 0.5)) : now };
    });
    forecast = {
      ready: true, history_days: history,
      confidence: history >= 60 ? 'high' : history >= 30 ? 'medium' : 'low',
      next30: Math.round(fut.reduce((s, x) => s + x.u, 0)), prev30: sum(total, k30), weeks,
      best_days: useWeekdays ? order.slice(0, 2).map(i => WEEKDAYS[i]) : [],
      slow_days: useWeekdays ? [WEEKDAYS[order[6]]] : [],
      rising: perProduct.filter(p => p.next > p.now).sort((a, b) => (b.next - b.now) - (a.next - a.now)).slice(0, 2),
      falling: perProduct.filter(p => p.next < p.now).sort((a, b) => (a.next - a.now) - (b.next - b.now)).slice(0, 2)
    };
  }

  // per-product numbers for the extra widgets
  const defaultThr = await defThr(oid), today = utcDay(k90[89]);
  const items = prods.rows.map(p => {
    const o = byProduct.get(p.id) || {}, sold30 = sum(o, k30), prev = sum(o, prev30);
    const lastDay = [...k90].reverse().find(d => o[d]), price = p.selling_price, cost = p.cost_price;
    return {
      name: p.name, quantity: p.quantity, price, cost, sold30,
      threshold: p.low_stock_threshold ?? defaultThr,
      margin: price > 0 && cost != null ? Math.round((price - cost) / price * 1000) / 10 : null,
      value: p.quantity * (cost || 0),
      last_sold_days: lastDay ? Math.round((today - utcDay(lastDay)) / 864e5) : null,
      next30: prev ? Math.max(0, Math.round(sold30 + (sold30 - prev) * 0.5)) : sold30
    };
  });

  // reorder planner: cover next 30 days of expected demand plus the low-stock threshold
  const planAll = items.map(i => {
    const cover = i.sold30 > 0 ? i.quantity / (i.sold30 / 30) : null, order = Math.max(0, i.next30 + i.threshold - i.quantity);
    return { name: i.name, quantity: i.quantity, cover, order, cost_total: i.cost != null ? order * i.cost : null, low: i.quantity <= i.threshold };
  }).filter(p => p.order > 0 && (p.low || (p.cover != null && p.cover < 21)))
    .sort((a, b) => (a.cover ?? 1e9) - (b.cover ?? 1e9) || a.quantity - b.quantity);

  res.json({
    days, analysis, forecast,
    items: items.map(({ threshold, next30, ...rest }) => rest),
    plan: planAll.slice(0, 6).map(({ low, ...rest }) => rest),
    plan_count: planAll.length,
    budget: planAll.reduce((s, p) => s + (p.cost_total || 0), 0),
    calendar: k90.slice(6).map(d => ({ date: d, units: total[d] || 0 })),
    feed: feedRows.rows.map(r => ({ id: r.id, name: r.name, delta: r.delta, note: r.note, at: r.created_at }))
  });

});

app.use('/api', (req, res, next) => next(bad('Not found', 404)));
app.use((e, req, res, next) => {
  if (e.type === 'entity.parse.failed' || (e instanceof SyntaxError && e.status === 400 && 'body' in e)) {
    e = bad('Request body must contain valid JSON', 400);
  }
  if (e.code === '23505' || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const detail = String(e.detail || e.message || '');
    const constraint = String(e.constraint || '');
    if (constraint.includes('users_email') || detail.includes('email') || detail.includes('users.email')) {
      e = bad('That email is already registered', 409);
    } else if (constraint.includes('products_org_id_sku') || constraint.includes('sku') || detail.includes('sku') || detail.includes('products.org_id')) {
      e = bad('A product with that SKU already exists', 409);
    } else {
      e = bad('A record with those unique values already exists', 409);
    }
  }
  if (e.code === '23514') {
    e = bad('Stock cannot go below zero.', 400);
  }
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' });
});

if (require.main === module) {
  db.initSchema()
    .then(() => {
      const port = process.env.PORT || 3000;
      app.listen(port, () => console.log('StockFlow on http://localhost:' + port));
    })
    .catch(err => {
      console.error('Failed to initialize database schema:', err);
      process.exit(1);
    });
}
module.exports = app;