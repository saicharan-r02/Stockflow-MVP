process.env.NODE_ENV = 'test';

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (e) {}
}

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
    await client.query("DELETE FROM orgs WHERE name LIKE 'Org %' OR name = 'Same SKU, other org'");
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
    await client.query("DELETE FROM orgs WHERE name LIKE 'Org %' OR name = 'Same SKU, other org'");
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
  return { s: r.status, c: (r.headers.get('set-cookie') || '').split(';')[0], d: await r.json() };
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
