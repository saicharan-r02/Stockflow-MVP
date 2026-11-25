# StockFlow MVP

> **Live Deployment:** [https://stockflow-mvp-yhr8.onrender.com](https://stockflow-mvp-yhr8.onrender.com)  
> *Hosted on Render (free tier) with Neon Serverless PostgreSQL.*

A multi-tenant inventory management app. Each organisation signs up, manages its own products, adjusts stock, gets low-stock alerts and watches a live analytics dashboard: stock movement, stock health, sales analysis, a 30-day forecast and more.

**Stack:** Node.js 22+, Express 5, Neon PostgreSQL (`pg`), JWT in an `httpOnly` cookie, bcryptjs, and a vanilla JavaScript single-page app (one `public/index.html`) with Chart.js 4.4.1.

---

## ✨ Features

- **Authentication:** sign up with organisation name, email and password (8+ characters), then log in. The session is a signed JWT in an `httpOnly` cookie (7 days). Login and signup are rate-limited.
- **Multi-tenancy:** every query is scoped by the authenticated user's `org_id`, so one organisation can never read or change another's data.
- **Products:** create, edit, delete and search by name or SKU. SKUs are upper-cased and unique within an organisation.
- **Stock adjustments:** add or remove units with an optional note. Stock can never drop below zero.
- **Low-stock alerts:** a per-product threshold, falling back to an organisation-wide default (initially `5`).
- **Live dashboard:** refreshes every 5 seconds while the tab is visible. It shows an inventory snapshot, sales analysis, a 30-day forecast, a stock-movement chart, stock health, top products, low-stock items with estimated days left, a stock-value treemap, a sold-vs-restocked chart and a 5-week sales calendar.
- **Interface:** dark and light themes (remembered in the browser), a collapsible sidebar and a responsive layout.

---

## 📸 Screenshots

### 1. Login
Sign in to your workspace. New organisations use the **Create an account** link, and a theme toggle sits in the top-right corner.

![Login page](docs/screenshots/01-login.png)

### 2. Dashboard Overview
Inventory snapshot (products, units on hand, stock value at cost, low-stock items), 30-day sales analysis with the busiest day, and a 30-day sales forecast.

![Dashboard overview](docs/screenshots/02-dashboard-overview.png)

### 3. Stock Movement (Last 30 Days)
One bar per day showing opening and closing total units. Hover a bar to see which items moved that day; click to pin the day's panel with opened, closed and change per item.

![Stock movement chart with daily breakdown](docs/screenshots/03-stock-movement.png)

### 4. Stock Health
Doughnut chart splitting products into In stock, Low stock and Out of stock. Selecting a status lists its products and the counts recorded during your session.

![Stock health doughnut chart](docs/screenshots/04-stock-health.png)

### 5. Inventory Board, Restock Trends & Sales Calendar
Top products by quantity (amber = low stock), low-stock items with days-left estimates, a stock-value treemap, a sold-vs-restocked chart and a 5-week sales calendar heatmap.

![Inventory board, sold vs restocked and sales calendar](docs/screenshots/05-inventory-board.png)

### 6. Products
Organisation-scoped product table with search by name or SKU, status badges and quick actions: **Adjust stock**, **Edit** and **Delete**.

![Products list](docs/screenshots/06-products.png)

### 7. Add Product
Create a product with name, SKU, description, quantity on hand, an optional per-product low-stock threshold, cost price and selling price.

![Add product form](docs/screenshots/07-add-product.png)

### 8. Settings
Set the organisation-wide default low-stock threshold, applied to any product without its own.

![Settings page](docs/screenshots/08-settings.png)

---

## ⚡ Live Application & Demo Accounts

**Production URL:** [https://stockflow-mvp-yhr8.onrender.com](https://stockflow-mvp-yhr8.onrender.com)

> **Cold-start notice:** the app runs on Render's free tier, which spins the service down after 15 minutes without traffic. The first request after that can take up to about a minute. Once warm, responses are immediate.  
> **Persistence:** data lives in Neon PostgreSQL, so accounts, products and stock history survive cold starts and redeploys.

### Demo credentials

| Organisation | Email | Password | Sample data |
|---|---|---|---|
| **Demo Store** | `demo@stockflow.app` | `demo12345` | 12 products with a randomised 30-day stock history |
| **NovaTech Electronics** | `novatech@stockflow.app` | `novatech12345` | 15 products, 518 units and a fixed, repeatable stock history |

*Tip: log in to each account in a separate browser profile (or a normal and an incognito window) to see tenant isolation in action.*

---

## 🚀 Getting Started

**Requirements:** Node.js 22+ and a PostgreSQL database (Neon recommended).

### 1. Environment

```bash
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgresql://user:pass@ep-xyz-pooler.region.aws.neon.tech/neondb?sslmode=require`. Required. |
| `TEST_DATABASE_URL` | A separate database (for example a Neon branch) used only by `npm test`. |
| `JWT_SECRET` | Secret used to sign sessions. **Required when `NODE_ENV=production`**; outside production the app falls back to an insecure development default. |
| `PORT` | HTTP port (default `3000`). |
| `NODE_ENV` | Set to `production` when deployed. This makes `JWT_SECRET` mandatory and marks the session cookie `Secure`. |

The `.env` file is loaded with Node's built-in `process.loadEnvFile()`, so no `dotenv` package is needed.

> **Security note:** never commit `.env` (it is in `.gitignore`) or share database credentials.

### 2. Install, seed and run

```bash
npm ci
npm run seed     # optional: creates both demo organisations (safe to re-run)
npm start        # http://localhost:3000
npm test         # integration tests, run against TEST_DATABASE_URL only
```

- **Schema:** tables and indexes are created automatically on first start (`db.js`), so no manual SQL is needed.
- **Seed:** `npm run seed` adds each demo account only if its email does not exist yet. It never overwrites data or duplicates products.
- **Tests:** the suite covers auth, validation, product CRUD, stock adjustments, low-stock logic, tenant isolation and dashboard totals. It refuses to start if `TEST_DATABASE_URL` is missing or equal to `DATABASE_URL`, so production and demo data are protected.

---

## ☁️ Deploy (Render + Neon)

1. Create a Neon project and copy its **pooled** connection string.
2. Create a Render **Web Service** from the repository:
   - **Build command:** `npm ci`
   - **Start command:** `npm start`
3. Add environment variables:
   - `NODE_ENV=production`
   - `DATABASE_URL` = your Neon connection string
   - `JWT_SECRET` = a long random value, for example `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
4. Deploy. The schema is created on the first boot.
5. *(Optional)* Load the demo organisations. Render's free tier has no shell access, so run the seed from your own machine instead: put the Neon `DATABASE_URL` in your local `.env` and run `npm run seed`.

---

## 🗂️ Project Structure

```
├── public/index.html   # Single-page app (HTML, CSS and JS in one file)
├── server.js           # Express app and API routes
├── db.js               # PostgreSQL pool, schema initialisation, DNS fallback
├── seed.js             # Idempotent demo data
├── test.js             # Integration tests (node:test)
├── docs/screenshots/   # README images
├── .env.example        # Environment template
└── package.json
```

---

## 🔌 API

All endpoints are under `/api`. Everything except signup, login and logout needs the session cookie and returns `401` without it. Accessing another organisation's product returns `404`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/signup` | Create an organisation and its first user, then start a session. `400` for invalid input, `409` if the email is taken. |
| POST | `/auth/login` | Log in (`401` for bad credentials). |
| POST | `/auth/logout` | Clear the session cookie. |
| GET | `/me` | Current user and organisation. |
| GET | `/products` | List products, sorted by name, each with `threshold_used` and `is_low`. |
| GET | `/products/:id` | One product. |
| POST | `/products` | Create a product (logged as "Initial stock"). |
| PUT | `/products/:id` | Update a product. Omitted fields keep their current values; a quantity change is logged. |
| POST | `/products/:id/adjust` | Add or remove units: `{ "delta": -3, "note": "optional" }`. |
| DELETE | `/products/:id` | Delete a product (the removal is logged). |
| GET / PUT | `/settings` | Read or update the organisation's default low-stock threshold. |
| GET | `/dashboard` | Totals, stock value, low-stock list with days of cover, stock health, top 8 products and the 30-day trend. |
| GET | `/insights` | Sales analysis, forecast, per-day breakdown, per-item metrics and the 5-week calendar. It also returns reorder-plan and recent-activity data that the current UI does not display. |

---

## 🗄️ Data Model

| Table | Notes |
|---|---|
| `orgs` | Organisation name and `default_threshold` (default `5`). |
| `users` | Unique email, bcrypt hash and `org_id` (cascades on delete). |
| `products` | Per-organisation products with `UNIQUE(org_id, sku)`, `CHECK (quantity >= 0)`, optional prices and threshold, and `last_updated_by` (cascades on delete). |
| `stock_events` | Signed quantity changes (`delta`) with a note and timestamp, indexed by `(org_id, created_at)`. It has no foreign keys, so history survives product deletion. |

---

## 🧮 How the Numbers Work

- **Stock status:** *Out of stock* means quantity `0`. *Low stock* means `quantity <= threshold`, using the product's own threshold or else the organisation default. Otherwise *In stock*. The "Low-stock items" count includes out-of-stock products.
- **Stock events:** every quantity change is logged as a delta: initial stock on create, edits, adjustments and deletions. It powers the charts but is not a full audit log.
- **Sales are inferred.** There is no orders module. Any outbound movement (a negative delta, except deleting a product) counts as *sold*, and positive deltas count as *restocked*. Dates are grouped by UTC day.
- **Stock movement chart:** one bar per day for the last 30 days. *Open* is the previous day's total units and *close* is that day's total. Green means the total rose or stayed flat, red means it fell, and a dashed line marks the latest close. For a new organisation the chart starts at its first recorded movement.
- **Days left (days of cover):** current quantity divided by average daily outbound units. The average uses the last 30 days, or the shorter period since the product's first movement. It shows **No usage data** when there is no outbound movement.
- **Forecast:** needs about two weeks of sales history. The next-30-day estimate starts from the average daily sales of the last 14 days, adds a damped trend based on how that compares with the 14 days before, and applies a weekday pattern once there are 21+ days of history. Confidence is *low* under 30 days of history, *medium* from 30 and *high* from 60. "May sell more/less" compares each product's last 30 days with its projection.
- **Stock health readings:** the "recent readings" list is recorded in your browser during the session and resets when the page reloads.

---

## 🔒 Security

- Passwords are hashed with bcryptjs (cost 10).
- Sessions are JWTs in an `httpOnly`, `SameSite=Lax` cookie that lasts 7 days and is `Secure` in production.
- Signup and login are limited to 20 attempts per minute per IP (in-memory limiter).
- All SQL is parameterised and scoped by `org_id`; the frontend escapes user content before rendering.
- Input is validated server-side: email format, password length, field lengths, whole numbers of 0 or more, a 50 KB JSON body limit, and clean `400` errors for malformed JSON.
- The database enforces non-negative stock, unique emails and per-organisation unique SKUs, and the API turns these violations into clear `400` and `409` responses.
- `x-powered-by` is disabled and `trust proxy` is enabled for hosting behind Render's proxy.
- `db.js` falls back to public DNS resolvers (8.8.8.8 and 1.1.1.1) if the system resolver cannot resolve the database host.

## ⚠️ Known Limitations (MVP)

- No HTTP security-header middleware (such as Helmet) or Content Security Policy yet.
- Password hashing uses bcryptjs's synchronous functions, which briefly block the server during login and signup.
- Stock adjustments run in a transaction and rely on the `quantity >= 0` constraint; there are no row-level locks, so simultaneous edits to the same product are last-write-wins.
- Non-numeric product IDs in the URL (for example `/api/products/abc`) return a generic `500` instead of `400`/`404`.
- The rate limiter is in memory, so it is per-instance and resets on restart.
- The PostgreSQL connection does not verify the server's TLS certificate (`rejectUnauthorized: false`).

## 🚫 Out of Scope (per MVP PRD)

Password reset, multi-user organisations, CSV import, integrations, multi-warehouse inventory, order/purchase-order management, billing and role-based access control.
