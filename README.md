# PDF Studio — PDF generation service

[![CI](https://github.com/juanpabloortizo/pdf-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/juanpabloortizo/pdf-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docker image](https://img.shields.io/badge/ghcr.io-pdf--studio-2496ED?logo=docker&logoColor=white)](https://github.com/juanpabloortizo/pdf-studio/pkgs/container/pdf-studio)

Self-hosted, open-source service to **design PDF templates and generate them over a REST API**.

- **Engine:** HTML + CSS → PDF with Puppeteer (headless Chromium). Pixel-perfect.
- **Templates:** HTML with Handlebars variables `{{client}}`, repeating rows `<tr data-each="items">`.
- **Visual editor:** drag & drop (text, image, table, QR, barcode, shapes) + a code editor.
- **Interactive docs:** Swagger UI at `/docs`.

## Run locally

```bash
npm install
npx puppeteer browsers install chrome   # downloads Chromium (once)
API_KEY=secret123 node server.js
```

- App:  http://localhost:8088/
- Docs: http://localhost:8088/docs  (Swagger UI — try requests live)
- API:  http://localhost:8088/v1/...

`API_KEY` seeds the key on first run; rotate it later from the **API** section in the app.

## Authentication

Every `/v1/*` call needs an API key:

```
X-API-KEY: <your key>          # or:  Authorization: Bearer <your key>
```

Manage keys in the panel (**API** section): create as many as you need, each with a
**name**, an optional **expiry** (30/90 days, 1 year, or never) and **scopes** that limit
what it can do:

| Scope | Allows |
|---|---|
| `pdf:create` | generate PDFs (`POST /v1/create`) |
| `templates:read` | list & read templates |
| `templates:write` | delete templates |
| `generations:read` | list & download generations |
| `generations:write` | delete generations · create/revoke share links |

A key that lacks the required scope gets `403`; an expired or unknown key gets `401`.
The full key is shown **once** at creation — copy it then.

## How variables work

A template declares variables (`{{client}}`) and lists (`{{#each items}}`). When you
generate a PDF you pass them in the **`data`** object, keyed by name. To discover the
exact shape for a template, call `GET /v1/templates/{template_id}` — it returns the
`variables` and a ready-made **`sample_data`** you can drop straight into `data`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/v1/templates` | list templates (id, name, variables) |
| GET  | `/v1/templates/{template_id}` | one template: variables + `sample_data` (the body shape) |
| DELETE | `/v1/templates/{template_id}` | delete a template |
| POST | `/v1/create` | generate a PDF from a template + `data` |
| GET  | `/v1/generations` | list past generations (each with a download `url`) |
| GET  | `/v1/generations/{transaction_id}.pdf` | download a generated PDF |
| DELETE | `/v1/generations/{transaction_id}` | delete a generation |
| DELETE | `/v1/shares/{token}` | revoke a share link |
| GET  | `/s/{token}` | **public** — open a shared PDF in the browser (no API key) |

`template_id` accepts the template's **UUID** (`tpl_…`, shown on each card) or its name.

### Generate a PDF

```bash
curl -X POST http://localhost:8088/v1/create \
  -H "X-API-KEY: <your key>" -H "Content-Type: application/json" \
  -d '{
    "template_id": "tpl_xxxxxxxx",
    "output_name": "quote-0001.pdf",
    "export_type": "pdf",
    "data": {
      "client": "Sample Client",
      "items": [{ "description": "Service", "qty": 1, "price": 100000 }],
      "subtotal": 100000, "tax": 19000, "total": 119000
    }
  }' --output quote.pdf
```

- `output_name` (optional) → the file name shown in the history and used on download.
- `export_type: "pdf"`    → raw PDF binary (download/attach).
- `export_type: "base64"` (default) → JSON `{ status, transaction_id, url, bytes, file: <base64> }`.
  The `url` lets you fetch the same PDF later (with your API key).

### Shareable links (public)

`share` is an **optional add-on** — the PDF is generated exactly as usual; setting
`share: true` just adds a public `share_url` to the response. Anyone with that link
opens the PDF in a browser **without an API key** (like a signed storage URL), so you
can hand it to a client or embed it.

```jsonc
// request body add-ons for POST /v1/create
{
  "template_id": "tpl_xxxxxxxx",
  "data": { "client": "Sample Client" },
  "share": false,          // ← set true to also return a public link (default: false)
  "share_ttl": "7d"        // ← expiry: "30m" / "24h" / "7d" / seconds. Omitted → 7 days. null or "never" = permanent
}
```

The response then includes:

```jsonc
{ "status": "success", "transaction_id": "abc123", "url": "…", "file": "<base64>",
  "share_url": "https://your-host/s/IyhShl4zIbYENM2NJWzWaA",
  "share_expires_at": "2026-09-22T00:00:00.000Z" }   // null when permanent
```

Managing links:

- **Revoke a link** (stops working immediately): `DELETE /v1/shares/{token}`.
- **Open it:** `GET /s/{token}` — public, serves the PDF inline. Returns 404 once
  expired or revoked.

(In the panel, the dashboard also has a "share link" action on each generated PDF.)

> If you deploy behind the provided `Caddyfile`, `/s/*` is exposed publicly (like
> `/v1/*`), while the rest of the panel stays behind the password.

## Templates

Live in `templates/*.html`. Plain HTML with:
- Simple variables: `{{client}}`, `{{total}}`
- Repeating rows: `<tr data-each="items"> … </tr>` (survives the visual editor)
- Helpers: `{{money price}}` (currency), `{{multiply qty price}}`
- QR / barcode: `<img data-qr="{{code}}">`, `<img data-barcode="{{code}}">` (rendered for real)
- Preview sample data: `<!--SAMPLE { ...json... } SAMPLE-->`

## Security

What's built in:

- **API auth** — every `/v1/*` call needs the API key; compared in constant time.
- **Rate limiting** — `/v1/*` is capped per IP (default 60 req/min, env `RATE_LIMIT`).
- **Render limits** — max concurrent renders (`RENDER_CONCURRENCY`, default 3) and a
  per-render timeout (`RENDER_TIMEOUT_MS`, default 15000) so expensive PDFs can't pile up.
- **Anti-SSRF** — the renderer blocks requests to internal targets (cloud metadata
  `169.254.169.254`, `localhost`, private IP ranges) and non-http(s) schemes.
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS.
- **Login (local accounts)** — the whole panel (Dashboard, Templates, editor, `/api/*`,
  `/docs`) is behind a login. On first run the app asks you to **create the owner account**;
  after that it's a normal sign-in. Passwords are hashed with `scrypt` and stored in a local
  **SQLite** database (`data/pdfstudio.db`); sessions are httpOnly, SameSite=Lax cookies
  (Secure over HTTPS). Login is **rate-limited** (20 attempts / 15 min per IP, `LOGIN_RATE_LIMIT`)
  to stop brute force, and failed logins are constant-time to avoid user enumeration.
  No external service.

Deployment hardening (important — the panel must **not** be public without a lock):

- Terminate **HTTPS** at Caddy (the provided `Caddyfile` does this automatically).
- The `Caddyfile` exposes **only** `/v1/*` and `/health` publicly; the panel, visual
  editor, `/api/*` and `/docs` sit behind **basic auth** (user + password).
- Use a long random `API_KEY` (`openssl rand -hex 32`); keep `.env` out of git.
- Rotate the API key from the app if it leaks (old key stops working immediately).
- The API key is masked in the UI (Reveal to show); the panel auto-logs-out after 10 min idle.

Not yet done (roadmap): multi-user login with per-user API keys and scopes.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `API_KEY` | random | seeds the REST API key on first run |
| `RATE_LIMIT` | 60 | max `/v1` requests per IP per minute |
| `LOGIN_RATE_LIMIT` | 20 | max login/setup attempts per IP per 15 min |
| `RENDER_CONCURRENCY` | 3 | max simultaneous PDF renders |
| `RENDER_TIMEOUT_MS` | 15000 | per-render timeout |
| `PORT` | 8088 | server port |

## Deploy (Docker)

Use the prebuilt image (published to GHCR on every release):

```bash
docker run -p 8088:8088 -e API_KEY=<strong-token> ghcr.io/juanpabloortizo/pdf-studio:latest
```

…or build it yourself:

```bash
docker build -t pdf-studio .
docker run -p 8088:8088 -e API_KEY=<strong-token> pdf-studio
```

**For a real server with a custom domain + automatic HTTPS**, follow the
step-by-step guide in **[DEPLOY.md](DEPLOY.md)** (Docker Compose + Caddy; Caddy
fetches and renews the Let's Encrypt certificate for you).
