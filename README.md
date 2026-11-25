# StockFlow MVP

> **Live Deployment:** [https://stockflow-mvp-yhr8.onrender.com](https://stockflow-mvp-yhr8.onrender.com)  
> *Hosted on Render with Neon Serverless PostgreSQL.*

Multi-tenant inventory management application featuring secure authentication, organisation-scoped product CRUD, transactional stock adjustments, low-stock alerts, and an analytics dashboard with interactive charts.

**Stack:** Node.js 22+, Express 5, Neon PostgreSQL (`pg`), JWT in an `httpOnly` cookie, bcryptjs, Helmet security headers, vanilla JavaScript SPA, and Chart.js.

---

## 📸 Screenshots

### 1. Login
Secure sign-in with an `httpOnly` JWT cookie. New organisations can create an account from the same screen, and a theme toggle sits in the top-right corner.

![Login page](docs/screenshots/01-login.png)

### 2. Dashboard Overview
Inventory snapshot (products, units on hand, stock value at cost, low-stock items), 30-day sales analysis with the busiest day, and a 30-day sales forecast.

![Dashboard overview](docs/screenshots/02-dashboard-overview.png)

### 3. Stock Movement (Last 30 Days)
Hover a bar to see exactly which items moved that day; click to pin the day's breakdown panel with opened, closed and net change per item.

![Stock movement chart with daily breakdown](docs/screenshots/03-stock-movement.png)

### 4. Stock Health
Doughnut chart splitting products into In stock, Low stock and Out of stock. Selecting a status lists the products in it.

![Stock health doughnut chart](docs/screenshots/04-stock-health.png)

### 5. Inventory Board, Restock Trends & Sales Calendar
Top products by quantity (amber = low stock), low-stock items with days-of-cover estimates, a stock-value treemap, a sold-vs-restocked trend, and a 5-week sales calendar heatmap.

![Inventory board, sold vs restocked and sales calendar](docs/screenshots/05-inventory-board.png)

### 6. Products
Organisation-scoped product table with search by name or SKU, status badges, and quick actions: **Adjust stock**, **Edit** and **Delete**.

![Products list](docs/screenshots/06-products.png)

### 7. Add Product
Create a product with SKU, description, quantity on hand, an optional per-product low-stock threshold, cost price and selling price.

![Add product form](docs/screenshots/07-add-product.png)

### 8. Settings
Set the organisation-wide default low-stock threshold, applied to any product without its own threshold.

![Settings page](docs/screenshots/08-settings.png)

---

## ⚡ Live Application & Demo Accounts

### Live URL
- **Production URL:** [https://stockflow-mvp-yhr8.onrender.com](https://stockflow-mvp-yhr8.onrender.com)

> **Render Cold-Start Notice:** The application is hosted on Render's free tier. If the service has been inactive for 15+ minutes, Render spins down the compute container. The initial request may take **30–50 seconds** to wake up. Once warmed up, response times are immediate.  
> **Neon PostgreSQL Persistence:** The database runs on Neon Serverless PostgreSQL with persistent storage. All organisation accounts, product data, and stock histories are completely preserved across cold starts and deployments.

### Demo Credentials

| Organisation | Email | Password | Sample Data Included |
|---|---|---|---|
| **Demo Store** | `demo@stockflow.app` | `demo12345` | 12 products, 30-day stock event history |
| **NovaTech Electronics** | `novatech@stockflow.app` | `novatech12345` | 15 products, 518 units, deterministic stock movements |

*Tip: Open two different browser profiles or one normal window and one incognito window to see multi-tenant isolation in real time.*

---

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
- Stock adjustments use PostgreSQL transactions (`BEGIN`, `COMMIT`, `ROLLBACK`) with a checked-out pool client and row-level locking (`SELECT ... FOR UPDATE`) to prevent race conditions during concurrent requests.
- Inventory quantities cannot drop below zero and enforce positive numeric bounds.
- Product ID parameters are strictly validated (`parseId`) to reject non-integer IDs before reaching PostgreSQL.
- Low stock is evaluated as `quantity <= threshold` (product-specific threshold, otherwise organisation default; default is `5`).
- `stock_events` stores quantity deltas for the 30-day stock trend; it is not a full audit log.
- The trend begins at the first recorded movement in the displayed period. Hovering the line selects the nearest date and shows the full date and total units.
- Days of cover is an estimate: current quantity divided by average daily outbound units over the last 30 calendar days (or the shorter recorded history for a new product). It displays “No usage data” when there are no recorded outbound movements.
- Dashboard charts: total units over time (line), stock health (doughnut), and top products by quantity (bar).
- Security headers are enforced via `helmet` (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`) with a Content Security Policy (CSP) supporting Google Fonts, Chart.js from cdnjs, and vanilla SPA scripts.
- Authentication utilizes non-blocking asynchronous bcryptjs hashing (`await bcrypt.hash` and `await bcrypt.compare`).

## Out of scope (per MVP PRD)

Password reset, multi-user organisations, CSV import, integrations, multi-warehouse inventory, order/purchase-order management, billing and role-based access control.
