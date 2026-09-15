# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-15

First public release.

### Features

- **HTML → PDF engine** with Puppeteer (headless Chromium) + Handlebars templating.
- **Visual editor** (GrapesJS): text, image, table, QR, barcode, shapes; import HTML.
- **Code editor** with live preview, a **Format** (beautify) button, and a
  **Fill data** button that builds the sample JSON from a template's variables.
- **REST API** (`/v1`): create PDFs, list/read/delete templates, list/download/delete
  generations. Interactive Swagger docs at `/docs`.
- **Shareable links**: `share: true` on `POST /v1/create` returns a public `share_url`
  (default 7-day expiry; `null`/`"never"` for permanent). Revoke with `DELETE /v1/shares/{token}`.
- **Multiple API keys** with names, expiry (30/90 days, 1 year, never) and scopes
  (`pdf:create`, `templates:read/write`, `generations:read/write`).
- **Local accounts**: owner-first login, scrypt password hashing, SQLite sessions.
- **Dashboard** with generation history (filters, pagination, preview, per-file share links).
- **Security**: API-key auth, `/v1` rate limiting, render concurrency/timeout limits,
  anti-SSRF, security headers, masked keys, idle auto-logout.
- **Deploy**: Dockerfile (Node 22 base), `docker-compose.yml` + `Caddyfile`
  (automatic HTTPS), and a step-by-step [DEPLOY.md](DEPLOY.md).

[1.0.0]: https://github.com/juanpabloortizo/pdf-studio/releases/tag/v1.0.0
