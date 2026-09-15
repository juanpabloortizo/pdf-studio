# Contributing to PDF Studio

Thanks for your interest in improving PDF Studio! Contributions of all kinds are
welcome — bug reports, features, docs, and templates.

## Getting started

```bash
git clone https://github.com/juanpabloortizo/pdf-studio.git
cd pdf-studio
npm install
npx puppeteer browsers install chrome   # downloads Chromium (once)
API_KEY=dev-key node server.js
```

Then open http://localhost:8088 — on first run the app asks you to create the
owner account.

- **App:** http://localhost:8088
- **Interactive API docs:** http://localhost:8088/docs
- **REST API:** http://localhost:8088/v1/…

## Project layout

| Path | What it is |
|---|---|
| `server.js` | Express app: pages, panel `/api/*`, public REST `/v1/*` |
| `lib/render.js` | HTML → PDF/PNG with Puppeteer + Handlebars |
| `lib/store.js` | JSON persistence (history, templates, shares) |
| `lib/apikeys.js` | Multiple API keys with scopes + expiry |
| `lib/auth.js` / `lib/db.js` | Local login (scrypt + SQLite sessions) |
| `public/app.html` | Main SPA (dashboard, templates, create, API, account) |
| `public/studio.html` | Visual drag-and-drop editor (GrapesJS) |
| `public/docs.html` | Swagger UI |

## Making changes

1. Create a branch: `git checkout -b feat/my-change`.
2. Keep changes focused; match the surrounding code style.
3. Test locally — build the Docker image to be sure it still boots:
   ```bash
   docker build -t pdf-studio:test .
   docker run --rm -p 8088:8088 -e API_KEY=test pdf-studio:test
   curl -s http://localhost:8088/health   # -> {"ok":true}
   ```
4. Open a pull request against `main`. CI will build the image and smoke-test it.

## Guidelines

- The UI and docs are in **English**.
- Don't commit generated data or personal templates — `data/` and most of
  `templates/` are git-ignored on purpose.
- Never commit secrets (API keys, `.env`).

## Reporting bugs / requesting features

Use the issue templates. For security issues, see [SECURITY.md](SECURITY.md) —
please do **not** open a public issue for vulnerabilities.
