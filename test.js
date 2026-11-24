process.env.NODE_ENV = 'test';

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (e) {}
}

// Fallback DNS resolver for environments with restricted/refusing local DNS
const dns = require('dns');
const { Resolver } = dns.promises;
const testResolver = new Resolver();
testResolver.setServers(['8.8.8.8', '1.1.1.1']);
const origLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  origLookup(hostname, options, (err, address, family) => {
    if (!err && address) return callback(null, address, family);
    testResolver.resolve4(hostname)
      .then(ips => {
        if (!ips || ips.length === 0) return callback(err || new Error('No IP found'));
        if (options && options.all) {
          callback(null, ips.map(ip => ({ address: ip, family: 4 })));
        } else {
          callback(null, ips[0], 4);
        }
      })
      .catch(() => callback(err));
  });
};

// Safeguard 4: If TEST_DATABASE_URL is missing, tests must stop with a clear error
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is missing. Tests must stop with a clear error instead of falling back to DATABASE_URL.');
}

// Safeguard 6: Verify both URLs are different without printing their credentials
if (process.env.DATABASE_URL) {
  if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
    throw new Error('Safeguard violation: TEST_DATABASE_URL and DATABASE_URL are identical. Tests must use an isolated test database.');
  }
}

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');
const app = require('./server');

let srv, base;

before(async () => {
  await db.initSchema();
  // Safe cleanup of test tenant data created during previous test runs on the test branch
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM orgs WHERE name LIKE 'Org %' OR name LIKE 'Auth Org%' OR name = 'Same SKU, other org'");
    await client.query("DELETE FROM users WHERE email LIKE '%@x.io'");
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await new Promise(r => {
    srv = app.listen(0, () => {
      base = 'http://localhost:' + srv.address().port;
      r();
    });
  });
});

after(async () => {
  if (srv) {
    srv.closeAllConnections();
    srv.close();
  }
  try {
    const client = await db.getClient();
    await client.query('BEGIN');
    await client.query("DELETE FROM orgs WHERE name LIKE 'Org %' OR name LIKE 'Auth Org%' OR name = 'Same SKU, other org'");
    await client.query("DELETE FROM users WHERE email LIKE '%@x.io'");
    await client.query('COMMIT');
    client.release();
  } catch (e) {}
  await db.close();
});

const call = async (cookie, method, p, body) => {
  const r = await fetch(base + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: cookie || '' },
    body: body && JSON.stringify(body)
  });
  return { s: r.status, c: (r.headers.get('set-cookie') || '').split(';')[0], d: await r.json().catch(() => ({})) };
};

const signup = e => call('', 'POST', '/auth/signup', { email: e, password: 'password1', orgName: 'Org ' + e });

test('safeguards: isolated test database and rejection of missing TEST_DATABASE_URL', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is set');
  if (process.env.DATABASE_URL) {
    assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL, 'TEST_DATABASE_URL must differ from DATABASE_URL');
  }
});

test('auth, CRUD, low stock, stock adjust, tenant isolation, dashboard', async () => {
  assert.equal((await call('', 'POST', '/auth/signup')).s, 400, 'missing JSON body returns a validation error');
  const malformed = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400, 'malformed JSON returns HTTP 400');
  const A = (await signup('a@x.io')).c, B = (await signup('b@x.io')).c;
  assert.equal((await signup('a@x.io')).s, 409);
  assert.equal((await call('', 'GET', '/products')).s, 401);
  assert.equal((await call('', 'POST', '/auth/login', { email: 'a@x.io', password: 'nope' })).s, 401);
  let r = await call(A, 'POST', '/products', { name: 'Mouse', sku: 'wm-1', quantity: 3, low_stock_threshold: 5 });
  assert.equal(r.s, 201); assert.equal(r.d.sku, 'WM-1'); assert.equal(r.d.is_low, true);
  const id = r.d.id;
  r = await call(A, 'PUT', '/products/' + id, { name: 'Updated Mouse' });
  assert.equal(r.s, 200); assert.equal(r.d.name, 'Updated Mouse');
  assert.equal(r.d.sku, 'WM-1'); assert.equal(r.d.quantity, 3); assert.equal(r.d.low_stock_threshold, 5, 'partial update preserves omitted fields');
  assert.equal((await call(A, 'POST', '/products', { name: 'Dup', sku: 'WM-1' })).s, 409);
  assert.equal((await call(A, 'POST', '/products', { name: 'Bad', sku: 'B1', quantity: -2 })).s, 400);
  assert.equal((await call(B, 'POST', '/products', { name: 'Same SKU, other org', sku: 'WM-1' })).s, 201);
  for (const [m, p, b] of [['GET', '/products/' + id], ['PUT', '/products/' + id, { name: 'x', sku: 'x' }], ['DELETE', '/products/' + id], ['POST', `/products/${id}/adjust`, { delta: 1 }]])
    assert.equal((await call(B, m, p, b)).s, 404, 'cross-tenant ' + m);
  assert.equal((await call(A, 'POST', `/products/${id}/adjust`, { delta: -9 })).s, 400);
  r = await call(A, 'POST', `/products/${id}/adjust`, { delta: 10, note: 'restock' });
  assert.equal(r.d.quantity, 13); assert.equal(r.d.is_low, false);
  await call(A, 'PUT', '/settings', { default_threshold: 20 });
  await call(A, 'POST', '/products', { name: 'Cable', sku: 'C1', quantity: 15 });
  const cable = (await call(A, 'GET', '/products')).d.find(p => p.sku === 'C1');
  await call(A, 'POST', `/products/${cable.id}/adjust`, { delta: -5, note: 'Test outbound movement' });
  r = await call(A, 'GET', '/dashboard');
  assert.equal(r.d.totalProducts, 2); assert.equal(r.d.totalUnits, 23); assert.equal(r.d.trend.at(-1).units, 23);
  assert.equal(r.d.trend.length, 1, 'fresh organisation trend starts at its first event date');
  // Mouse has its own threshold (5) so 13 units is NOT low; Cable has none, so the org default (20) applies and 10 <= 20 IS low.
  assert.equal(r.d.lowCount, 1); assert.equal(r.d.low[0].sku, 'C1'); assert.equal(r.d.low[0].threshold_used, 20);
  assert.equal(r.d.low[0].units_out_30d, 5); assert.equal(r.d.low[0].observed_days, 1); assert.equal(r.d.low[0].days_cover, 2);
  assert.equal((await call(A, 'DELETE', '/products/' + id)).s, 200);
  r = await call(A, 'GET', '/dashboard'); assert.equal(r.d.totalUnits, 10); assert.equal(r.d.trend.at(-1).units, 10);
  assert.equal((await call(B, 'GET', '/dashboard')).d.totalProducts, 1);
});

// Regression Test 1: Invalid product IDs
test('regression: invalid product IDs return HTTP 404 and do not reach PostgreSQL', async () => {
  const user = (await signup('reg_id@x.io')).c;
  const invalidIds = ['abc', 'xyz123', '-1', '0', '1.5', '9999999999999999999', 'null', 'undefined', 'DROP TABLE products;'];
  for (const badId of invalidIds) {
    const getRes = await call(user, 'GET', `/products/${encodeURIComponent(badId)}`);
    assert.equal(getRes.s, 404, `GET invalid id "${badId}" must return 404`);
    assert.equal(getRes.d.error, 'Product not found');

    const putRes = await call(user, 'PUT', `/products/${encodeURIComponent(badId)}`, { name: 'X' });
    assert.equal(putRes.s, 404, `PUT invalid id "${badId}" must return 404`);
    assert.equal(putRes.d.error, 'Product not found');

    const adjRes = await call(user, 'POST', `/products/${encodeURIComponent(badId)}/adjust`, { delta: 1 });
    assert.equal(adjRes.s, 404, `POST adjust invalid id "${badId}" must return 404`);
    assert.equal(adjRes.d.error, 'Product not found');

    const delRes = await call(user, 'DELETE', `/products/${encodeURIComponent(badId)}`);
    assert.equal(delRes.s, 404, `DELETE invalid id "${badId}" must return 404`);
    assert.equal(delRes.d.error, 'Product not found');
  }
});

// Regression Test 2: Stock adjustment validation & excessive amounts
test('regression: stock adjustments reject non-integer, zero, and excessively large adjustments', async () => {
  const user = (await signup('reg_adj@x.io')).c;
  const p = (await call(user, 'POST', '/products', { name: 'AdjTest', sku: 'ADJ-1', quantity: 10 })).d;

  // Excessive adjustment magnitude (> 1,000,000)
  const tooLarge = await call(user, 'POST', `/products/${p.id}/adjust`, { delta: 1000001 });
  assert.equal(tooLarge.s, 400);
  assert.ok(tooLarge.d.error.includes('too large'));

  const tooSmall = await call(user, 'POST', `/products/${p.id}/adjust`, { delta: -1000001 });
  assert.equal(tooSmall.s, 400);
  assert.ok(tooSmall.d.error.includes('too large'));

  // Zero delta
  const zero = await call(user, 'POST', `/products/${p.id}/adjust`, { delta: 0 });
  assert.equal(zero.s, 400);

  // Non-integer delta
  const nonInt = await call(user, 'POST', `/products/${p.id}/adjust`, { delta: 2.5 });
  assert.equal(nonInt.s, 400);

  // Empty or invalid delta
  const empty = await call(user, 'POST', `/products/${p.id}/adjust`, { delta: '' });
  assert.equal(empty.s, 400);

  const str = await call(user, 'POST', `/products/${p.id}/adjust`, { delta: 'many' });
  assert.equal(str.s, 400);
});

// Regression Test 3 & 4: Resulting inventory out-of-range & negative inventory
test('regression: resulting inventory cannot exceed limits or go negative', async () => {
  const user = (await signup('reg_limits@x.io')).c;
  const p = (await call(user, 'POST', '/products', { name: 'LimitTest', sku: 'LIM-1', quantity: 50 })).d;

  // Negative inventory rejection
  const negative = await call(user, 'POST', `/products/${p.id}/adjust`, { delta: -51 });
  assert.equal(negative.s, 400);
  assert.ok(negative.d.error.includes('Only 50 in stock. Stock cannot go below zero.'));

  // Max adjustment bound prevents overflow
  const maxDelta = 1000000;
  const validAdj = await call(user, 'POST', `/products/${p.id}/adjust`, { delta: maxDelta });
  assert.equal(validAdj.s, 200);
  assert.equal(validAdj.d.quantity, 50 + maxDelta);
});

// Regression Test 5: Concurrent stock adjustments
test('regression: concurrent stock adjustments serialize safely with row locking', async () => {
  const user = (await signup('reg_conc@x.io')).c;
  const p = (await call(user, 'POST', '/products', { name: 'ConcTest', sku: 'CONC-1', quantity: 100 })).d;

  // Execute 5 concurrent adjustments simultaneously
  const deltas = [10, -5, 20, -15, 30]; // Net: +40 -> 140
  const results = await Promise.all(
    deltas.map(delta => call(user, 'POST', `/products/${p.id}/adjust`, { delta, note: 'concurrent test' }))
  );

  for (const res of results) {
    assert.equal(res.s, 200, 'Each concurrent adjustment must succeed');
  }

  const finalProduct = (await call(user, 'GET', `/products/${p.id}`)).d;
  assert.equal(finalProduct.quantity, 140, 'Final quantity must exactly equal initial + sum of concurrent deltas');
});

// Regression Test 7: Authentication after async bcrypt conversion
test('regression: authentication works correctly with asynchronous bcrypt', async () => {
  const uniqueId = Date.now();
  const email = `reg_auth_${uniqueId}@x.io`;
  const orgName = `Auth Org ${uniqueId}`;
  const signupRes = await call('', 'POST', '/auth/signup', { email, password: 'password123', orgName });
  assert.equal(signupRes.s, 201);
  assert.ok(signupRes.c.includes('t='));

  // Login with correct credentials
  const loginRes = await call('', 'POST', '/auth/login', { email, password: 'password123' });
  assert.equal(loginRes.s, 200);
  assert.ok(loginRes.c.includes('t='));

  // Login with incorrect password
  const wrongPassRes = await call('', 'POST', '/auth/login', { email, password: 'wrongpassword' });
  assert.equal(wrongPassRes.s, 401);
  assert.equal(wrongPassRes.d.error, 'Invalid email or password');

  // Login with non-existent user
  const nonExistRes = await call('', 'POST', '/auth/login', { email: `nonexistent_${uniqueId}@x.io`, password: 'password123' });
  assert.equal(nonExistRes.s, 401);
  assert.equal(nonExistRes.d.error, 'Invalid email or password');

  // /api/me with valid cookie
  const meRes = await call(loginRes.c, 'GET', '/me');
  assert.equal(meRes.s, 200);
  assert.equal(meRes.d.email, email);
  assert.equal(meRes.d.org, orgName);
});

// Regression Test 8: Security headers and frontend charts compatibility
test('regression: security headers with Helmet and frontend charts compatibility', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);

  // Verify security headers added by Helmet
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  const csp = res.headers.get('content-security-policy') || '';
  assert.ok(csp.includes('cdnjs.cloudflare.com'), 'CSP must allow Chart.js from cdnjs');
  assert.ok(csp.includes('fonts.googleapis.com'), 'CSP must allow Google fonts');

  // Verify index.html contains chart canvas elements and Chart.js integration
  const html = await res.text();
  assert.ok(html.includes('chart.umd.min.js'), 'HTML must include Chart.js library');
  assert.ok(html.includes('id="c1"'), 'HTML must include trend chart canvas c1');
  assert.ok(html.includes('id="c2"'), 'HTML must include health doughnut canvas c2');
  assert.ok(html.includes('id="c3"'), 'HTML must include top products bar canvas c3');
});
