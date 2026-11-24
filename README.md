# StockFlow MVP

> **Live Deployment:** [https://stockflow-mvp.onrender.com](https://stockflow-mvp.onrender.com) *(Update with your active service URL upon deployment)*

Multi-tenant inventory app: signup/login, organisation-scoped product CRUD, concurrent-safe stock adjustments, low-stock threshold alerts, days-of-cover forecasting and an interactive dashboard with inventory charts.

**Stack:** Node.js 22+, Express 5, Neon PostgreSQL (`pg`), Helmet security headers, JWT in HTTP-only cookies, bcryptjs, vanilla JavaScript SPA, and Chart.js.

---

## Demo Accounts

Both accounts belong to independent organisations and demonstrate complete multi-tenant data isolation:

| Organisation | Email | Password | Preloaded Inventory & Data |
|---|---|---|---|
| **Demo Store** | `demo@stockflow.app` | `demo12345` | 12 office tech products with randomized 30-day stock movement history |
| **NovaTech Electronics** | `novatech@stockflow.app` | `novatech12345` | 15 products, 518 units on hand, and a deterministic 30-day stock trend |

> **Tenant Isolation:** Log into `demo@stockflow.app` in a standard browser tab and `novatech@stockflow.app` in an incognito window. Each tenant's catalog, stock events, thresholds, and dashboard metrics remain strictly isolated.

---

## User Interface Overview

### Dashboard View
The dashboard provides a real-time overview of inventory metrics, 30-day stock trends, stock health breakdown, and top products by quantity:

```
+---------------------------------------------------------------------------------------+
|  StockFlow                                                        NovaTech Electronics |
|  [Dashboard] [Products] [Settings]                                 novatech@...app     |
|                                                                    [Log out]           |
+---------------------------------------------------------------------------------------+
|  Products: 15     Units on hand: 518     Stock value: $15,820.50     Low-stock items: 3|
+------------------------------------------------------+--------------------------------+
|  Total units on hand, last 30 days                   |  Stock health                  |
|  [Line Chart: 30-day trend with date hover tooltips] |  [Doughnut Chart: In/Low/Out]  |
+------------------------------------------------------+--------------------------------+
|  Top products by quantity (amber = low stock)        |  Low-stock items (Days Cover)  |
|  [Horizontal Bar Chart: top 8 products]              |  [Table: Name, SKU, Qty, Cover]|
+------------------------------------------------------+--------------------------------+
```

### Product Catalog & Stock Adjustments
- **Catalog Management:** Create, edit, search, and delete products scoped to the authenticated organisation.
- **Stock Adjustments:** Apply positive or negative inventory movements with optional notes logged to `stock_events`.
- **Integrity & Bounds:** Prevents negative inventory, rejects adjustments exceeding $\pm 1,000,000$ units, and prevents integer overflow.
- **Concurrency Safety:** Product adjustments use PostgreSQL row-level locks (`SELECT ... FOR UPDATE`) inside transactions to safely serialize concurrent inventory adjustments.

---

## Environment Configuration

StockFlow uses Neon serverless PostgreSQL. Copy `.env.example` to `.env` to configure local variables:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon PostgreSQL production connection string (with TLS) |
| `TEST_DATABASE_URL` | For Tests | Isolated Neon development branch connection string (e.g. `stockflow-test`) |
| `JWT_SECRET` | Production | Secret key for signing HTTP-only authentication cookies |
| `PORT` | Optional | HTTP port for the Express application (default: `3000`) |

> **Security Requirements:**
> - Never commit `.env` or credentials to source control.
> - Automated integration tests run **exclusively** against `TEST_DATABASE_URL` and will immediately abort if `TEST_DATABASE_URL` is missing or matches `DATABASE_URL`.

---

## Local Development & Testing

```bash
# 1. Install dependencies
npm ci

# 2. Initialize demo accounts (idempotent; safe to repeat)
npm run seed

# 3. Start local server (http://localhost:3000)
npm start

# 4. Run automated integration & regression test suite
npm test
```

---

## Security Architecture

1. **Strict Product ID Validation:**
   All routes accepting `:id` (`GET`, `PUT`, `POST .../adjust`, `DELETE`) strictly validate that `:id` is a positive 32-bit integer. Malformed IDs (such as `/api/products/abc` or SQL injection attempts) return HTTP 404 immediately without reaching PostgreSQL.
2. **Stock Adjustment & Overflow Guards:**
   Adjustments must be non-zero integers bounded to $\pm 1,000,000$ units per operation. Negative inventory is rejected with HTTP 400. PostgreSQL numeric overflow error (`22003`) is intercepted and returned as a clear HTTP 400 validation error.
3. **Database TLS:**
   The connection pool uses standard Neon connection strings with secure TLS certificate verification (`ssl: true`).
4. **Asynchronous Authentication:**
   Password hashing and comparison use asynchronous `bcrypt.hash` and `bcrypt.compare` to prevent blocking the Node.js event loop during high authentication concurrency.
5. **Security Headers (Helmet) & Content Security Policy (CSP):**
   Helmet provides protection against clickjacking (`X-Frame-Options: SAMEORIGIN`), MIME-sniffing (`X-Content-Type-Options: nosniff`), and sets appropriate referrer and opener policies.
   - *Current CSP Configuration:* Allows inline scripts/styles and external resources required by the frontend (`cdnjs.cloudflare.com` for Chart.js, `fonts.googleapis.com` / `fonts.gstatic.com` for Bricolage Grotesque typography).
   - *Strict CSP Path:* Enforcing a strict CSP without `'unsafe-inline'` requires extracting inline `<style>` and `<script>` blocks in `public/index.html` into standalone versioned bundle assets served with cryptographic nonces or SHA-256 integrity hashes.

---

## Deployment (Render & Neon)

### Render Free Tier Cold-Start Behavior
- Render spins down Free Web Service instances after 15 minutes of inactivity.
- The initial incoming request will trigger a cold-start container spin-up, resulting in a 30–50 second response delay before the service begins serving requests.
- Subsequent requests will respond with sub-second latency while the service remains warm.

### Neon PostgreSQL Persistence
- Neon serverless compute instances automatically suspend after 5 minutes of zero database connections to optimize resource usage.
- Compute resumes automatically within 500–1000 milliseconds upon incoming connection.
- All database records, constraints, demo organisations, and stock events are stored durably in Neon cloud storage and persist indefinitely across Render container restarts and redeployments.

### Render Configuration
- **Build Command:** `npm ci`
- **Start Command:** `npm start`
- **Environment Variables:**
  - `NODE_ENV=production`
  - `DATABASE_URL=<your-neon-pooled-connection-string>`
  - `JWT_SECRET=<long-cryptographically-random-string>`
