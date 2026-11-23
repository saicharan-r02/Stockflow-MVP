# StockFlow MVP

Multi-tenant inventory app: signup/login, organisation-scoped product CRUD, stock adjustments, low-stock settings and a dashboard with inventory charts.

**Stack:** Node.js 22+, Express, SQLite (`better-sqlite3`), JWT in an httpOnly cookie, bcrypt, vanilla JavaScript SPA and Chart.js.

## Run locally

```bash
npm ci
npm run seed     # optional: creates two demo organisations and sample history
npm start        # http://localhost:3000
npm test         # API integration tests
```

### Demo accounts

| Organisation | Email | Password | Data |
|---|---|---|---|
| Demo Store | `demo@stockflow.app` | `demo12345` | 12 products and 30-day sample stock history |
| NovaTech Electronics | `novatech@stockflow.app` | `novatech12345` | 15 products, 518 units and a deterministic up/down stock trend |

Both accounts belong to separate organisations. They can be used to demonstrate tenant isolation by opening separate normal and incognito browser sessions. The seed script is idempotent: it creates a demo account only when its email does not already exist and does not overwrite existing organisation data.

## Windows install note for Node.js 26

The `better-sqlite3` 13.x line has a reported Windows issue where installation can invoke `node-gyp` and require Visual Studio C++ tools even when a prebuilt binary is available. If `npm ci` fails at `better-sqlite3` on Windows with Node.js 26, run this once to switch to the 12.x release with Node 24/26 prebuilt support and refresh the lockfile:

```powershell
npm install better-sqlite3@12.11.1 --save-exact
npm ci
```

If that installation still attempts a native build, install Visual Studio Build Tools with the **Desktop development with C++** workload, then retry. Do not copy `node_modules` between machines or Node versions.

## Environment

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Required when `NODE_ENV=production`; use a long random secret |
| `PORT` | HTTP port (default `3000`) |
| `DB_PATH` | SQLite file path (default `./stockflow.db`) |

## Deploy (Render / Railway)

Build: `npm ci` · Start: `npm start` · Environment: `NODE_ENV=production`, `JWT_SECRET=<long random string>`.

SQLite lives on local disk, so attach a persistent disk/volume and set `DB_PATH` to a path on it (for example `/var/data/stockflow.db`). Without persistent storage, data may be lost when the service is redeployed or its instance is replaced. Run `npm run seed` once from the host shell only when you want the demo accounts.

## Design notes

- Product, settings and dashboard queries are scoped by the authenticated user's `org_id`.
- SKUs are upper-cased and unique within each organisation.
- Quantity cannot be negative.
- Low stock is `quantity <= threshold` (product-specific threshold, otherwise organisation default; initial default is `5`).
- `stock_events` stores quantity deltas for the 30-day stock trend; it is not a full audit log.
- The trend begins at the first recorded movement in the displayed period. Hovering the line selects the nearest date and shows the full date and total units.
- Days of cover is an estimate: current quantity divided by average daily outbound units over the last 30 calendar days (or the shorter recorded history for a new product). It displays “No usage data” when there are no recorded outbound movements.
- Dashboard charts: total units over time (line), stock health (doughnut), and top products by quantity (bar).

## Out of scope (per MVP PRD)

Password reset, multi-user organisations, CSV import, integrations, multi-warehouse inventory, order/purchase-order management, billing and role-based access control.
