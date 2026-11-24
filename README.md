# StockFlow MVP

Multi-tenant inventory app: signup/login, organisation-scoped product CRUD, stock adjustments, low-stock settings and a dashboard with inventory charts.

**Stack:** Node.js 22+, Express, Neon PostgreSQL (`pg`), JWT in an httpOnly cookie, bcrypt, vanilla JavaScript SPA and Chart.js.

## Environment Configuration

StockFlow uses PostgreSQL (optimized for Neon serverless Postgres). Copy `.env.example` to `.env` and configure your credentials:

```bash
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL production connection string (e.g. `postgresql://user:pass@ep-xyz.neon.tech/neondb?sslmode=require`) |
| `TEST_DATABASE_URL` | Isolated Neon development branch connection string for automated integration tests |
| `JWT_SECRET` | Required when `NODE_ENV=production`; use a long random secret |
| `PORT` | HTTP port (default `3000`) |

> **Security Note:** Never commit `.env` or expose database credentials. Automated integration tests require `TEST_DATABASE_URL` and will reject running against `DATABASE_URL` to protect production and demo data.

## Database & Schema Initialization

Schema creation is fully idempotent and managed automatically by the application on startup via `db.js`:
- Creates tables: `orgs`, `users`, `products`, `stock_events`.
- Enforces multi-tenant foreign keys (`ON DELETE CASCADE`), indexes (`ix_events_org`), per-tenant SKU uniqueness (`UNIQUE(org_id, sku)`), and non-negative quantity constraints (`quantity >= 0`).
- No manual SQL scripts in the Neon console are required.

## Run Locally

```bash
npm ci
npm run seed     # optional: initializes both demo organisations in PostgreSQL (idempotent)
npm start        # http://localhost:3000
npm test         # API integration tests (runs exclusively against TEST_DATABASE_URL)
```

### Demo accounts

| Organisation | Email | Password | Data |
|---|---|---|---|
| Demo Store | `demo@stockflow.app` | `demo12345` | 12 products and 30-day sample stock history |
| NovaTech Electronics | `novatech@stockflow.app` | `novatech12345` | 15 products, 518 units and a deterministic up/down stock trend |

Both accounts belong to separate organisations. They demonstrate tenant isolation by opening separate normal and incognito browser sessions. The seed script is idempotent: it initializes demo accounts only when their email does not already exist and does not overwrite existing organisation data or duplicate products on repeated runs.

## Deploy (Render / Railway / Cloud)

1. **Build & Install:**
   ```bash
   npm ci
   ```
2. **Start Command:**
   ```bash
   npm start
   ```
3. **Environment Variables:**
   - Set `NODE_ENV=production`
   - Set `DATABASE_URL` to your Neon PostgreSQL pooled connection string
   - Set `JWT_SECRET` to a cryptographically secure random string

Database tables and indexes are initialized automatically on the first server boot. Run `npm run seed` once from the deployment shell if you wish to populate the demo organisations.

## Design notes

- Product, settings and dashboard queries are scoped by the authenticated user's `org_id`.
- SKUs are upper-cased and unique within each organisation.
- Stock adjustments use PostgreSQL transactions (`BEGIN`, `COMMIT`, `ROLLBACK`) with a checked-out pool client.
- Inventory quantities cannot drop below zero.
- Low stock is evaluated as `quantity <= threshold` (product-specific threshold, otherwise organisation default; default is `5`).
- `stock_events` stores quantity deltas for the 30-day stock trend; it is not a full audit log.
- The trend begins at the first recorded movement in the displayed period. Hovering the line selects the nearest date and shows the full date and total units.
- Days of cover is an estimate: current quantity divided by average daily outbound units over the last 30 calendar days (or the shorter recorded history for a new product). It displays “No usage data” when there are no recorded outbound movements.
- Dashboard charts: total units over time (line), stock health (doughnut), and top products by quantity (bar).

## Out of scope (per MVP PRD)

Password reset, multi-user organisations, CSV import, integrations, multi-warehouse inventory, order/purchase-order management, billing and role-based access control.
