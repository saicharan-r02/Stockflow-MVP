// npm run seed
// Creates two independent demo organisations. Safe to run more than once.
const bcrypt = require('bcryptjs');
const db = require('./db');

async function seedOriginalDemo() {
  const email = 'demo@stockflow.app';
  const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (existing.rows.length) {
    console.log(`${email} already exists; skipped`);
    return;
  }

  const products = [
    ['Wireless Mouse', 'WM-100', 48, 9, 19.99, 10],
    ['Mechanical Keyboard', 'KB-210', 14, 32, 64.99, 10],
    ['USB-C Cable 1m', 'UC-001', 120, 1.2, 6.99, 30],
    ['27" Monitor', 'MN-270', 6, 140, 229, 8],
    ['Laptop Stand', 'LS-050', 22, 11, 29.5, 8],
    ['Webcam 1080p', 'WC-108', 4, 18, 39.99, 6],
    ['Desk Mat', 'DM-900', 35, 5, 14.99, 10],
    ['Noise-Cancelling Headset', 'HS-400', 9, 45, 99, 10],
    ['HDMI Adapter', 'HD-020', 0, 3, 12.5, 10],
    ['Phone Stand', 'PS-010', 64, 2, 8.99, 15],
    ['Power Bank 20k', 'PB-200', 11, 16, 34.99, 12],
    ['Ethernet Cable 5m', 'EC-050', 77, 1.5, 7.5, 20]
  ];
  const rnd = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const orgRes = await client.query('INSERT INTO orgs(name) VALUES($1) RETURNING id', ['Demo Store']);
    const orgId = orgRes.rows[0].id;
    await client.query(
      'INSERT INTO users(org_id, email, password_hash) VALUES($1, $2, $3)',
      [orgId, email, bcrypt.hashSync('demo12345', 10)]
    );

    for (const [name, sku, quantity, cost, price, threshold] of products) {
      const pRes = await client.query(
        `INSERT INTO products(
          org_id, name, sku, description, quantity, cost_price,
          selling_price, low_stock_threshold, last_updated_by
        ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [orgId, name, sku, null, quantity, cost, price, threshold, email]
      );
      const productId = pRes.rows[0].id;
      const saleOne = rnd(5, 20);
      const saleTwo = rnd(5, 20);
      const restock = rnd(0, Math.min(40, quantity + saleTwo));
      const events = [
        [quantity + saleOne + saleTwo - restock, 29, 'Opening inventory'],
        [-saleOne, rnd(15, 25), 'Customer sales'],
        [restock, rnd(8, 14), 'Supplier restock'],
        [-saleTwo, rnd(1, 6), 'Customer sales']
      ];
      for (const [delta, daysAgo, note] of events) {
        if (delta) {
          const createdAt = new Date(Date.now() - daysAgo * 864e5).toISOString();
          await client.query(
            'INSERT INTO stock_events(org_id, product_id, delta, note, created_at) VALUES($1, $2, $3, $4, $5)',
            [orgId, productId, delta, note, createdAt]
          );
        }
      }
    }
    await client.query('COMMIT');
    console.log(`Seeded ${email} / demo12345 (Demo Store)`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedShowcaseDemo() {
  const email = 'novatech@stockflow.app';
  const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (existing.rows.length) {
    console.log(`${email} already exists; skipped`);
    return;
  }

  // Each product is described as:
  // [name, SKU, final quantity, opening quantity, cost, selling price,
  //  low-stock threshold, description, [[delta, daysAgo, note], ...]]
  // Opening quantity plus all dated deltas must equal final quantity.
  const products = [
    ['Wireless Mouse', 'WM-220', 46, 70, 9.50, 22.99, 10,
      'Ergonomic 2.4 GHz wireless mouse', [[-15, 27, 'Customer sales'], [25, 23, 'Supplier restock'], [-20, 6, 'Customer sales'], [-14, 2, 'Customer sales']]],
    ['Mechanical Keyboard', 'KB-320', 24, 20, 34.00, 69.99, 10,
      'Compact mechanical keyboard with white backlight', [[20, 25, 'Supplier restock'], [-16, 16, 'Customer sales']]],
    ['USB-C Cable 2m', 'UC-220', 120, 400, 1.80, 7.49, 30,
      'Braided 2 metre USB-C charging and data cable', [[-100, 27, 'Wholesale sales'], [150, 24, 'Supplier restock'], [-180, 21, 'Bulk customer order'], [220, 18, 'Supplier restock'], [-180, 15, 'Wholesale sales'], [160, 12, 'Supplier restock'], [-140, 9, 'Wholesale sales'], [100, 6, 'Supplier restock'], [-150, 3, 'Bulk customer order'], [-160, 1, 'Wholesale sales']]],
    ['27" Monitor', 'MN-270', 8, 20, 145.00, 239.00, 10,
      '27 inch QHD IPS monitor', [[-12, 14, 'Customer sales']]],
    ['Laptop Stand', 'LS-150', 32, 30, 12.50, 34.99, 8,
      'Adjustable aluminium laptop stand', [[15, 15, 'Supplier restock'], [-13, 5, 'Customer sales']]],
    ['Webcam 4K', 'WC-400', 7, 12, 38.00, 79.99, 8,
      'USB 4K webcam with privacy shutter', [[-5, 4, 'Customer sales']]],
    ['Desk Mat XL', 'DM-120', 54, 50, 8.00, 21.99, 10,
      'Extended non-slip desk mat', [[20, 21, 'Supplier restock'], [-16, 9, 'Customer sales']]],
    ['Noise-Cancelling Headset', 'HS-520', 12, 18, 49.00, 109.00, 15,
      'Over-ear wireless headset with active noise cancellation', [[-6, 12, 'Customer sales']]],
    ['HDMI Adapter', 'HD-040', 3, 10, 4.00, 14.99, 10,
      'USB-C to HDMI 4K adapter', [[-7, 10, 'Customer sales']]],
    ['Phone Stand', 'PS-220', 72, 55, 3.00, 11.99, 15,
      'Foldable adjustable desktop phone stand', [[30, 13, 'Supplier restock'], [-13, 3, 'Customer sales']]],
    ['Power Bank 20k', 'PB-220', 16, 24, 18.00, 39.99, 12,
      '20000 mAh fast-charge power bank', [[-8, 19, 'Customer sales']]],
    ['Ethernet Cable 5m', 'EC-550', 88, 90, 1.70, 8.99, 20,
      '5 metre Cat6 Ethernet cable', [[30, 17, 'Supplier restock'], [-32, 8, 'Customer sales']]],
    ['Portable SSD 1TB', 'SSD-1T', 14, 18, 58.00, 99.99, 12,
      '1 TB portable USB 3.2 solid-state drive', [[10, 7, 'Supplier restock'], [-14, 2, 'Customer sales']]],
    ['Smartwatch', 'SW-310', 22, 20, 45.00, 89.99, 8,
      'Bluetooth smartwatch with health and activity tracking', [[-10, 24, 'Customer sales'], [12, 1, 'Supplier restock']]],
    ['USB-C Dock', 'DK-710', 0, 8, 31.00, 59.99, 5,
      '7-in-1 USB-C docking station', [[-8, 22, 'Customer sales']]]
  ];

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const orgRes = await client.query('INSERT INTO orgs(name) VALUES($1) RETURNING id', ['NovaTech Electronics']);
    const orgId = orgRes.rows[0].id;
    await client.query(
      'INSERT INTO users(org_id, email, password_hash) VALUES($1, $2, $3)',
      [orgId, email, bcrypt.hashSync('novatech12345', 10)]
    );

    for (const [name, sku, finalQty, openingQty, cost, price, threshold, description, history] of products) {
      const historyTotal = history.reduce((sum, [delta]) => sum + delta, openingQty);
      if (historyTotal !== finalQty) {
        throw new Error(`Seed history for ${sku} totals ${historyTotal}, expected ${finalQty}`);
      }
      const pRes = await client.query(
        `INSERT INTO products(
          org_id, name, sku, description, quantity, cost_price,
          selling_price, low_stock_threshold, last_updated_by
        ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [orgId, name, sku, description, finalQty, cost, price, threshold, email]
      );
      const productId = pRes.rows[0].id;

      const openingDate = new Date(Date.now() - 29 * 864e5).toISOString();
      await client.query(
        'INSERT INTO stock_events(org_id, product_id, delta, note, created_at) VALUES($1, $2, $3, $4, $5)',
        [orgId, productId, openingQty, 'Opening inventory', openingDate]
      );
      for (const [delta, daysAgo, note] of history) {
        const eventDate = new Date(Date.now() - daysAgo * 864e5).toISOString();
        await client.query(
          'INSERT INTO stock_events(org_id, product_id, delta, note, created_at) VALUES($1, $2, $3, $4, $5)',
          [orgId, productId, delta, note, eventDate]
        );
      }
    }
    await client.query('COMMIT');
    console.log(`Seeded ${email} / novatech12345 (NovaTech Electronics)`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  await seedOriginalDemo();
  await seedShowcaseDemo();
  console.log('Seed complete. Existing accounts were left unchanged.');
  await db.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}

module.exports = { seedOriginalDemo, seedShowcaseDemo };
