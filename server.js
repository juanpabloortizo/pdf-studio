import express from "express";
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import rateLimit from "express-rate-limit";
import { renderHtmlToPdf, renderHtmlToImage, extractVars, extractSample } from "./lib/render.js";
import * as store from "./lib/store.js";
import * as auth from "./lib/auth.js";
import * as apikeys from "./lib/apikeys.js";

const PORT = process.env.PORT || 8088;
const TPL_DIR = "templates";
const THUMB_DIR = join("data", "thumbs");
if (!existsSync(TPL_DIR)) mkdirSync(TPL_DIR, { recursive: true });
if (!existsSync(THUMB_DIR)) mkdirSync(THUMB_DIR, { recursive: true });

// API keys en disco. En el primer arranque migra la key única antigua (o la env
// API_KEY) a una key "Default" con todos los permisos. Ver lib/apikeys.js.
apikeys.init(process.env.API_KEY || process.env.MCP_TOKEN);

// --- Sesiones por cookie httpOnly ---
const COOKIE = "pdfsid";
function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}` + (secure ? "; Secure" : ""));
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}
const currentUser = (req) => auth.userFromToken(getCookie(req, COOKIE));

// Variables de una plantilla en forma estructurada (para la API).
function variablesOf(html) {
  const { simple, arrays } = extractVars(html);
  return {
    fields: simple.map((name) => ({ name, type: "string" })),
    lists: arrays.map((name) => ({ name, type: "array" })),
  };
}

const app = express();
app.set("trust proxy", 1); // detras de Caddy/nginx: usa X-Forwarded-For real
app.disable("x-powered-by");

// Cabeceras de seguridad basicas en cada respuesta.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public", {
  setHeaders: (res, path) => { if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); },
}));
// URLs limpias (sin app.html#...): /dashboard, /templates, /api, /design, /docs
const page = (f) => (_req, res) => res.sendFile(join(process.cwd(), "public", f));
app.get("/", (_req, res) => res.redirect("/dashboard"));
app.get(["/dashboard", "/templates", "/create", "/api", "/account", "/login"], page("app.html"));
app.get("/design", page("studio.html"));
app.get("/docs", page("docs.html"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Enlace público compartible de un PDF (SIN API key): se abre en el navegador.
// El token se crea desde /v1/create ("share": true) o /v1/generations/:id/share.
app.get("/s/:token", (req, res) => {
  const s = store.resolveShare(req.params.token);
  if (!s) return res.status(404).type("html").send("<!doctype html><meta charset=utf-8><title>Link unavailable</title><body style='font-family:system-ui;text-align:center;padding:80px;color:#374151'><h1>Link expired or not found</h1><p>This shared document is no longer available.</p>");
  const p = store.pdfPath(s.id);
  if (!existsSync(p)) return res.status(404).type("html").send("<!doctype html><meta charset=utf-8><title>Link unavailable</title><body style='font-family:system-ui;text-align:center;padding:80px;color:#374151'><h1>Document no longer available</h1>");
  const gen = store.getGeneration(s.id);
  const fname = (gen && gen.output) || s.id + ".pdf";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fname}"`);
  res.send(readFileSync(p));
});

// Rate limit para la API publica (/v1/*): protege de abuso y DoS.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT || 60), // peticiones por IP por minuto
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate limit exceeded, slow down" },
});
app.use("/v1", apiLimiter);

// Rate limit estricto para el login/setup: frena la fuerza bruta de contraseñas.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT || 20), // intentos por IP por 15 min
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too many attempts, please try again in a few minutes" },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/setup", authLimiter);

// ---- Auth (login del dueno, sesion local) ----
app.get("/api/auth/status", (req, res) => {
  const user = currentUser(req);
  res.json({ setup_needed: auth.userCount() === 0, authenticated: !!user, user: auth.publicUser(user) });
});
app.post("/api/auth/setup", (req, res) => {
  if (auth.userCount() > 0) return res.status(400).json({ error: "already set up" });
  const { email, name, password } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "valid email required" });
  if (!password || String(password).length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  const u = auth.createUser({ email, name, password, role: "owner" });
  setSessionCookie(req, res, auth.createSession(u.id));
  res.json({ ok: true, user: auth.publicUser(u) });
});
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = auth.getUserByEmail(email);
  const ok = u ? auth.verifyPassword(password || "", u.pass_hash, u.pass_salt) : auth.dummyVerify(password);
  if (!u || !ok) return res.status(401).json({ error: "invalid email or password" });
  setSessionCookie(req, res, auth.createSession(u.id));
  res.json({ ok: true, user: auth.publicUser(u) });
});
app.post("/api/auth/logout", (req, res) => {
  auth.deleteSession(getCookie(req, COOKIE));
  clearSessionCookie(res);
  res.json({ ok: true });
});

// El panel (/api/* de datos) requiere sesion. Los /api/auth/* quedan abiertos.
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/auth/")) return next();
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  req.user = user;
  next();
});

// Cuenta del usuario (requiere sesion)
const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
app.patch("/api/account/profile", (req, res) => {
  const { name, email } = req.body || {};
  if (!email || !emailRe.test(email)) return res.status(400).json({ error: "valid email required" });
  const existing = auth.getUserByEmail(email);
  if (existing && existing.id !== req.user.id) return res.status(400).json({ error: "that email is already in use" });
  const u = auth.updateUser(req.user.id, { name, email });
  res.json({ ok: true, user: auth.publicUser(u) });
});
app.post("/api/account/password", (req, res) => {
  const { current, new_password } = req.body || {};
  const u = auth.getUserById(req.user.id);
  if (!auth.verifyPassword(current || "", u.pass_hash, u.pass_salt)) return res.status(400).json({ error: "current password is incorrect" });
  if (!new_password || String(new_password).length < 8) return res.status(400).json({ error: "new password must be at least 8 characters" });
  auth.updatePassword(req.user.id, new_password);
  res.json({ ok: true });
});

// ---------- helpers de plantillas ----------
const safeName = (n) => /^[a-z0-9_-]+$/i.test(n);
const tplPath = (n) => join(TPL_DIR, n + ".html");
const listTemplates = () =>
  readdirSync(TPL_DIR).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""));
const readTemplate = (n) => readFileSync(tplPath(n), "utf8");

// ================= API interna del panel (editor/dashboard) =================
app.get("/api/templates", (_req, res) => {
  const out = listTemplates().map((name) => {
    const st = statSync(tplPath(name));
    const meta = store.ensureTemplateMeta(name);
    return { name, id: meta.id, vars: extractVars(readTemplate(name)), createdAt: meta.createdAt, updatedAt: st.mtime.toISOString(), size: st.size };
  });
  res.json(out);
});

app.get("/api/template/:name", (req, res) => {
  const { name } = req.params;
  if (!safeName(name) || !existsSync(tplPath(name))) return res.status(404).json({ error: "no existe" });
  const html = readTemplate(name);
  const meta = store.ensureTemplateMeta(name);
  res.json({ name, id: meta.id, html, sample: extractSample(html), vars: extractVars(html) });
});

app.put("/api/template/:name", (req, res) => {
  const { name } = req.params;
  if (!safeName(name)) return res.status(400).json({ error: "nombre invalido (usa a-z 0-9 _ -)" });
  writeFileSync(tplPath(name), (req.body && req.body.html) || "", "utf8");
  const meta = store.ensureTemplateMeta(name);
  res.json({ ok: true, name, id: meta.id, vars: extractVars((req.body && req.body.html) || "") });
});

app.delete("/api/template/:name", (req, res) => {
  const { name } = req.params;
  if (!safeName(name) || !existsSync(tplPath(name))) return res.status(404).json({ error: "no existe" });
  unlinkSync(tplPath(name));
  store.removeTemplateMeta(name);
  try { unlinkSync(thumbPath(name)); } catch {}
  res.json({ ok: true });
});

app.post("/api/template/:name/clone", (req, res) => {
  const { name } = req.params;
  if (!safeName(name) || !existsSync(tplPath(name))) return res.status(404).json({ error: "no existe" });
  let dest = name + "_copia";
  let i = 2;
  while (existsSync(tplPath(dest))) dest = name + "_copia" + i++;
  writeFileSync(tplPath(dest), readTemplate(name), "utf8");
  const meta = store.ensureTemplateMeta(dest);
  res.json({ ok: true, name: dest, id: meta.id });
});

// Miniatura (PNG) de una plantilla con sus datos de ejemplo. Cacheada en disco;
// se regenera si la plantilla cambia.
const thumbPath = (n) => join(THUMB_DIR, n + ".png");
app.get("/api/thumb/:name", async (req, res) => {
  const { name } = req.params;
  if (!safeName(name) || !existsSync(tplPath(name))) return res.status(404).end();
  try {
    const srcMtime = statSync(tplPath(name)).mtimeMs;
    const cache = thumbPath(name);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache"); // el navegador revalida -> siempre la actual
    if (existsSync(cache) && statSync(cache).mtimeMs >= srcMtime) {
      return res.send(readFileSync(cache)); // cache en disco: no re-renderiza si no cambió
    }
    const html = readTemplate(name);
    const png = await renderHtmlToImage(html, extractSample(html));
    writeFileSync(cache, png);
    res.send(png);
  } catch (e) {
    res.status(500).end();
  }
});

// Preview en vivo del editor (HTML crudo + datos -> PDF)
app.post("/api/preview", async (req, res) => {
  try {
    const { html, data } = req.body || {};
    const pdf = await renderHtmlToPdf(html || "", data || {});
    res.setHeader("Content-Type", "application/pdf");
    res.send(Buffer.from(pdf));
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// Generar un PDF desde el panel (queda en el historial como source "ui")
app.post("/api/generate", async (req, res) => {
  const { template, data, output_name } = req.body || {};
  if (!template || !safeName(template) || !existsSync(tplPath(template))) return res.status(404).json({ error: "template not found" });
  try {
    const pdf = await renderHtmlToPdf(readTemplate(template), data || {});
    const filename = cleanFilename(output_name, template);
    const id = store.logGeneration({ template_id: template, source: "ui", pdf: Buffer.from(pdf), output: filename });
    res.json({ ok: true, transaction_id: id, output: filename, url: `${req.protocol}://${req.get("host")}/api/pdf/${id}` });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// Generación por lotes desde un CSV (una fila = un PDF). El motor limita la
// concurrencia internamente, así que disparamos todos y se procesan optimizados.
app.post("/api/generate/batch", async (req, res) => {
  const { template, rows, output_prefix } = req.body || {};
  if (!template || !safeName(template) || !existsSync(tplPath(template))) return res.status(404).json({ error: "template not found" });
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "no rows in CSV" });
  if (rows.length > 200) return res.status(400).json({ error: "max 200 rows per batch" });
  const html = readTemplate(template);
  const origin = `${req.protocol}://${req.get("host")}`;
  const prefix = (output_prefix && String(output_prefix).trim()) || template;
  const items = await Promise.all(rows.map(async (row, i) => {
    try {
      const pdf = await renderHtmlToPdf(html, row || {});
      const filename = cleanFilename(prefix + "-" + (i + 1), template);
      const id = store.logGeneration({ template_id: template, source: "batch", pdf: Buffer.from(pdf), output: filename });
      return { row: i + 1, transaction_id: id, output: filename, url: `${origin}/api/pdf/${id}` };
    } catch (e) {
      return { row: i + 1, error: String(e && e.message ? e.message : e) };
    }
  }));
  res.json({ ok: true, count: items.filter((x) => !x.error).length, failed: items.filter((x) => x.error).length, items });
});

// Dashboard: estadisticas, historial, y descarga de PDFs pasados
app.get("/api/stats", (_req, res) => res.json({ ...store.stats(), templates: listTemplates().length }));
app.get("/api/history", (_req, res) => res.json(store.getHistory(100)));
app.delete("/api/history/:id", (req, res) => {
  const ok = store.deleteGeneration(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});
app.post("/api/history/delete", (req, res) => {
  const removed = store.deleteGenerations((req.body && req.body.ids) || null); // sin ids = borra todo
  res.json({ ok: true, removed });
});
app.get("/api/pdf/:id", (req, res) => {
  const p = store.pdfPath(req.params.id);
  if (!/^[a-z0-9]+$/i.test(req.params.id) || !existsSync(p)) return res.status(404).end();
  const gen = store.getGeneration(req.params.id);
  const fname = (gen && gen.output) || (gen && gen.template_id ? gen.template_id + ".pdf" : req.params.id + ".pdf");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fname}"`);
  res.send(readFileSync(p));
});

// --- Gestión de API keys (panel, requiere sesión) ---
app.get("/api/keys", (_req, res) => res.json({ keys: apikeys.listKeys(), scopes: apikeys.SCOPES }));
app.post("/api/keys", (req, res) => {
  const { name, scopes, ttlDays } = req.body || {};
  res.json(apikeys.createKey({ name, scopes, ttlDays: ttlDays ? Number(ttlDays) : null }));
});
app.delete("/api/keys/:id", (req, res) => {
  const ok = apikeys.revokeKey(req.params.id);
  res.status(ok ? 200 : 404).json(ok ? { status: "revoked", id: req.params.id } : { error: "key not found" });
});

// Crear un enlace compartible desde el panel (sesión) para un PDF del historial.
app.post("/api/history/:id/share", (req, res) => {
  const id = String(req.params.id);
  if (!store.getGeneration(id) || !existsSync(store.pdfPath(id))) return res.status(404).json({ error: "generation not found" });
  const { token, expiresAt } = store.createShare(id, null); // permanente desde la UI
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({ share_url: `${origin}/s/${token}`, expires_at: expiresAt });
});

// ================= Public REST API =================
// Valida la API key y su scope. Devuelve true si pasa; si no, responde y devuelve false.
function requireKey(req, res, scope) {
  const key = req.headers["x-api-key"] || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const k = apikeys.authenticate(key);
  if (!k) { res.status(401).json({ error: "invalid or expired api key" }); return false; }
  if (scope && !k.scopes.includes(scope)) { res.status(403).json({ error: `api key lacks required scope: ${scope}` }); return false; }
  req.apiKey = k;
  return true;
}

app.get("/v1/templates", (req, res) => {
  if (!requireKey(req, res, "templates:read")) return;
  res.json({ templates: listTemplates().map((name) => ({
    template_id: store.ensureTemplateMeta(name).id, name, variables: variablesOf(readTemplate(name)),
  })) });
});

// Detalle de una plantilla: sus variables y un ejemplo del cuerpo (data).
app.get("/v1/templates/:template_id", (req, res) => {
  if (!requireKey(req, res, "templates:read")) return;
  const name = store.resolveTemplateName(req.params.template_id, (n) => safeName(n) && existsSync(tplPath(n)));
  if (!name) return res.status(404).json({ error: "template_id not found" });
  const html = readTemplate(name);
  const meta = store.ensureTemplateMeta(name);
  res.json({
    template_id: meta.id,
    name,
    variables: variablesOf(html),
    // "data" de ejemplo: exactamente lo que se manda en el body de /v1/create
    sample_data: extractSample(html),
    updated_at: meta.updatedAt,
  });
});

// ---- Documentación OpenAPI (para Swagger UI en /docs) ----
function buildOpenApi(origin) {
  return {
    openapi: "3.0.3",
    info: {
      title: "PDF Studio API",
      version: "1.0.0",
      description:
        "Generate PDFs from reusable HTML templates.\n\n" +
        "**Auth:** send your API key in the `X-API-KEY` header (or `Authorization: Bearer <key>`).\n\n" +
        "**API keys & scopes:** create keys in the panel (API section), each with a name, an " +
        "optional expiry, and scopes. Each endpoint needs a scope: `pdf:create`, `templates:read`, " +
        "`templates:write`, `generations:read`, `generations:write`. A key missing the scope gets `403`.\n\n" +
        "**How variables work:** each template declares variables like `{{client}}` and lists " +
        "(`{{#each items}}`). When you generate a PDF you pass those in the `data` object, keyed " +
        "by name. Call `GET /v1/templates/{template_id}` to see the exact variables and a ready-made " +
        "`sample_data` you can drop into the `data` field.",
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        ApiKeyHeader: { type: "apiKey", in: "header", name: "X-API-KEY" },
        BearerAuth: { type: "http", scheme: "bearer" },
      },
      responses: {
        Unauthorized: { description: "Missing or invalid API key", content: { "application/json": { example: { error: "invalid api key" } } } },
        NotFound: { description: "template_id not found", content: { "application/json": { example: { error: "template_id not found" } } } },
        RateLimited: { description: "Too many requests (rate limit)", content: { "application/json": { example: { error: "rate limit exceeded, slow down" } } } },
        GenerationNotFound: { description: "Generation not found", content: { "application/json": { example: { error: "generation not found" } } } },
      },
      schemas: {
        Template: {
          type: "object",
          properties: {
            template_id: { type: "string", example: "tpl_1234abcd" },
            name: { type: "string", example: "quote" },
            variables: {
              type: "object",
              properties: {
                fields: { type: "array", items: { type: "object" }, example: [{ name: "client", type: "string" }, { name: "total", type: "string" }] },
                lists: { type: "array", items: { type: "object" }, example: [{ name: "items", type: "array" }] },
              },
            },
          },
        },
      },
    },
    security: [{ ApiKeyHeader: [] }, { BearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          tags: ["Status"],
          summary: "Service status",
          description: "Public health check (no API key needed).",
          security: [],
          responses: { 200: { description: "Service is up", content: { "application/json": { example: { ok: true } } } } },
        },
      },
      "/v1/templates": {
        get: {
          tags: ["Templates"],
          summary: "List templates",
          description: "Every template with its `template_id` (UUID) and the variables it expects.",
          responses: {
            200: { description: "List of templates", content: { "application/json": { example: { templates: [
              { template_id: "tpl_1234abcd", name: "quote", variables: { fields: [{ name: "client", type: "string" }], lists: [{ name: "items", type: "array" }] } },
            ] } } } },
            401: { $ref: "#/components/responses/Unauthorized" }, 429: { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/v1/templates/{template_id}": {
        get: {
          tags: ["Templates"],
          summary: "Get a template (variables + sample body)",
          description: "Returns the template's variables and a `sample_data` object — the exact shape to send as `data` in POST /v1/create.",
          parameters: [{ name: "template_id", in: "path", required: true, schema: { type: "string" }, description: "Template UUID or name" }],
          responses: {
            200: { description: "Template detail", content: { "application/json": { example: {
              template_id: "tpl_1234abcd", name: "quote",
              variables: { fields: [{ name: "client", type: "string" }, { name: "total", type: "string" }], lists: [{ name: "items", type: "array" }] },
              sample_data: { client: "Sample Client", items: [{ description: "Service", qty: 1, price: 100000 }], total: 119000 },
              updated_at: "2026-09-15T04:00:00.000Z",
            } } } },
            401: { $ref: "#/components/responses/Unauthorized" }, 404: { $ref: "#/components/responses/NotFound" }, 429: { $ref: "#/components/responses/RateLimited" },
          },
        },
        delete: {
          tags: ["Templates"],
          summary: "Delete a template",
          parameters: [{ name: "template_id", in: "path", required: true, schema: { type: "string" }, description: "Template UUID or name" }],
          responses: {
            200: { description: "Deleted", content: { "application/json": { example: { status: "deleted", template_id: "tpl_1234abcd", name: "quote" } } } },
            401: { $ref: "#/components/responses/Unauthorized" }, 404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/v1/create": {
        post: {
          tags: ["Generate"],
          summary: "Generate a PDF",
          description: "Renders a template with your `data` and returns the PDF (binary or base64).",
          requestBody: {
            required: true,
            content: { "application/json": {
              schema: {
                type: "object", required: ["template_id"],
                properties: {
                  template_id: { type: "string", description: "Template UUID (tpl_…) or its name", example: "tpl_1234abcd" },
                  output_name: { type: "string", description: "Optional file name for the generated PDF (shown in history & used on download)", example: "quote-0001.pdf" },
                  export_type: { type: "string", enum: ["pdf", "base64"], default: "base64", description: "`pdf` = raw binary download · `base64` = JSON with the file + a download url" },
                  data: { type: "object", description: "Variables keyed by name (see GET /v1/templates/{id} → sample_data)", example: { client: "Sample Client", items: [{ description: "Service", qty: 1, price: 100000 }], total: 119000 } },
                  share: { type: "boolean", description: "If true, also creates a PUBLIC shareable link (`share_url`) that opens the PDF in a browser with no API key.", example: true },
                  share_ttl: { type: "string", description: "Optional expiry for the share link: `\"30m\"`, `\"24h\"`, `\"7d\"`, or seconds. Omit for a permanent link.", example: "7d" },
                },
              },
              example: { template_id: "tpl_1234abcd", export_type: "base64", share: true, share_ttl: "7d", data: { client: "Sample Client", items: [{ description: "Service", qty: 1, price: 100000 }], subtotal: 100000, tax: 19000, total: 119000 } },
            } },
          },
          responses: {
            200: { description: "Generated PDF", content: {
              "application/pdf": { schema: { type: "string", format: "binary" } },
              "application/json": { example: { status: "success", transaction_id: "abc123", template_id: "tpl_1234abcd", name: "quote", mime_type: "application/pdf", bytes: 64502, url: origin + "/v1/generations/abc123.pdf", share_url: origin + "/s/IyhShl4zIbYENM2NJWzWaA", share_expires_at: null, file: "<base64>" } },
            } },
            401: { $ref: "#/components/responses/Unauthorized" }, 404: { $ref: "#/components/responses/NotFound" }, 429: { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/v1/generations": {
        get: {
          tags: ["Generate"],
          summary: "List past generations",
          description: "Recent PDF generations (transactions), each with a download `url`.",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 50 } }],
          responses: {
            200: { description: "List of generations", content: { "application/json": { example: { generations: [
              { transaction_id: "abc123", template: "quote", bytes: 64502, created_at: "2026-09-15T04:00:00.000Z", url: origin + "/v1/generations/abc123.pdf" },
            ] } } } },
            401: { $ref: "#/components/responses/Unauthorized" }, 429: { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/v1/generations/{transaction_id}.pdf": {
        get: {
          tags: ["Generate"],
          summary: "Download a generated PDF",
          parameters: [{ name: "transaction_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "The PDF", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } },
            401: { $ref: "#/components/responses/Unauthorized" }, 404: { $ref: "#/components/responses/GenerationNotFound" },
          },
        },
      },
      "/v1/generations/{transaction_id}": {
        delete: {
          tags: ["Generate"],
          summary: "Delete a generation",
          parameters: [{ name: "transaction_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "Deleted", content: { "application/json": { example: { status: "deleted", transaction_id: "abc123" } } } },
            401: { $ref: "#/components/responses/Unauthorized" }, 404: { $ref: "#/components/responses/GenerationNotFound" },
          },
        },
      },
      "/v1/generations/{transaction_id}/share": {
        post: {
          tags: ["Share"],
          summary: "Create a public share link for a generation",
          description: "Returns a `share_url` that opens the PDF in a browser with **no API key**. Optionally expiring.",
          parameters: [{ name: "transaction_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: false,
            content: { "application/json": { schema: { type: "object", properties: {
              ttl: { type: "string", description: "Optional expiry: `\"30m\"`, `\"24h\"`, `\"7d\"`, or seconds. Omit for a permanent link.", example: "24h" },
            } } } },
          },
          responses: {
            200: { description: "Share link created", content: { "application/json": { example: { status: "success", transaction_id: "abc123", share_url: origin + "/s/IyhShl4zIbYENM2NJWzWaA", expires_at: "2026-09-22T00:00:00.000Z" } } } },
            401: { $ref: "#/components/responses/Unauthorized" }, 404: { $ref: "#/components/responses/GenerationNotFound" },
          },
        },
      },
      "/v1/shares/{token}": {
        delete: {
          tags: ["Share"],
          summary: "Revoke a share link",
          description: "The link stops working immediately.",
          parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "Revoked", content: { "application/json": { example: { status: "revoked", token: "IyhShl4zIbYENM2NJWzWaA" } } } },
            401: { $ref: "#/components/responses/Unauthorized" }, 404: { description: "Share not found", content: { "application/json": { example: { error: "share not found" } } } },
          },
        },
      },
      "/s/{token}": {
        get: {
          tags: ["Share"],
          summary: "Open a shared PDF (public, no API key)",
          description: "Serves the PDF inline in the browser. This is the link you hand to a client or embed. Returns 404 if expired or revoked.",
          security: [],
          parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "The PDF", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } },
            404: { description: "Link expired, revoked or not found" },
          },
        },
      },
    },
  };
}
app.get("/openapi.json", (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json(buildOpenApi(origin));
});

// Interpreta un TTL: número de segundos, o "30m"/"24h"/"7d"/"60s".
// Devuelve segundos, o null (= enlace permanente).
function parseTtl(v) {
  if (v == null || v === false || v === "") return null;
  if (typeof v === "number") return v > 0 ? Math.floor(v) : null;
  const m = String(v).trim().match(/^(\d+)\s*([smhd])?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || "s").toLowerCase()];
  return n > 0 ? n * mult : null;
}

// Limpia el nombre de archivo propuesto y garantiza extension .pdf
function cleanFilename(s, fallback) {
  let out = String(s || "").trim().replace(/[\/\\:*?"<>|]+/g, "_").slice(0, 120);
  if (!out) out = fallback;
  if (!/\.pdf$/i.test(out)) out += ".pdf";
  return out;
}

app.post("/v1/create", async (req, res) => {
  if (!requireKey(req, res, "pdf:create")) return;
  const { template_id, data, export_type, output_name, share, share_ttl } = req.body || {};
  // template_id acepta el UUID o el nombre
  const name = template_id ? store.resolveTemplateName(template_id, (n) => safeName(n) && existsSync(tplPath(n))) : null;
  if (!name) return res.status(404).json({ error: "template_id not found" });
  try {
    const pdf = await renderHtmlToPdf(readTemplate(name), data || {});
    const filename = cleanFilename(output_name, name);
    const id = store.logGeneration({ template_id: name, source: "api", pdf: Buffer.from(pdf), output: filename });
    const origin = `${req.protocol}://${req.get("host")}`;
    // Enlace público opcional ("share": true). "share_ttl" define expiración
    // (segundos o "30m"/"24h"/"7d"); si se omite, el enlace es permanente.
    let shareInfo = null;
    if (share) {
      const { token, expiresAt } = store.createShare(id, parseTtl(share_ttl));
      shareInfo = { share_url: `${origin}/s/${token}`, share_expires_at: expiresAt };
    }
    if (export_type === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      if (shareInfo) res.setHeader("X-Share-Url", shareInfo.share_url); // el enlace también en cabecera
      return res.send(Buffer.from(pdf));
    }
    res.json({
      status: "success",
      transaction_id: id,
      template_id: store.ensureTemplateMeta(name).id,
      name,
      output_name: filename,
      mime_type: "application/pdf",
      bytes: pdf.length,
      url: `${origin}/v1/generations/${id}.pdf`,   // descargable con la misma API key
      ...(shareInfo || {}),                         // share_url + share_expires_at (si se pidió)
      file: Buffer.from(pdf).toString("base64"),
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: String(e && e.message ? e.message : e) });
  }
});

// Historial de generaciones (transacciones)
app.get("/v1/generations", (req, res) => {
  if (!requireKey(req, res, "generations:read")) return;
  const origin = `${req.protocol}://${req.get("host")}`;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json({
    generations: store.getHistory(limit).map((h) => ({
      transaction_id: h.id, template: h.template_id, bytes: h.bytes,
      created_at: h.createdAt, url: `${origin}/v1/generations/${h.id}.pdf`,
    })),
  });
});

// Crear un enlace público compartible para una generación ya existente.
// Body opcional: { "ttl": "24h" | 86400 }  (omitir = permanente)
app.post("/v1/generations/:id/share", (req, res) => {
  if (!requireKey(req, res, "generations:write")) return;
  const id = String(req.params.id).replace(/\.pdf$/i, "");
  if (!store.getGeneration(id) || !existsSync(store.pdfPath(id))) return res.status(404).json({ error: "generation not found" });
  const { token, expiresAt } = store.createShare(id, parseTtl(req.body && req.body.ttl));
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({ status: "success", transaction_id: id, share_url: `${origin}/s/${token}`, expires_at: expiresAt });
});

// Revocar un enlace compartible (deja de funcionar de inmediato).
app.delete("/v1/shares/:token", (req, res) => {
  if (!requireKey(req, res, "generations:write")) return;
  const ok = store.revokeShare(req.params.token);
  res.status(ok ? 200 : 404).json(ok ? { status: "revoked", token: req.params.token } : { error: "share not found" });
});

// Borrar una plantilla
app.delete("/v1/templates/:template_id", (req, res) => {
  if (!requireKey(req, res, "templates:write")) return;
  const name = store.resolveTemplateName(req.params.template_id, (n) => safeName(n) && existsSync(tplPath(n)));
  if (!name) return res.status(404).json({ error: "template_id not found" });
  unlinkSync(tplPath(name));
  store.removeTemplateMeta(name);
  res.json({ status: "deleted", template_id: req.params.template_id, name });
});

// Borrar una generación pasada
app.delete("/v1/generations/:id", (req, res) => {
  if (!requireKey(req, res, "generations:write")) return;
  const id = String(req.params.id).replace(/\.pdf$/i, "");
  const ok = store.deleteGeneration(id);
  res.status(ok ? 200 : 404).json(ok ? { status: "deleted", transaction_id: id } : { error: "generation not found" });
});

// Descargar el PDF de una generación pasada  (/v1/generations/<id>.pdf)
app.get("/v1/generations/:file", (req, res) => {
  if (!requireKey(req, res, "generations:read")) return;
  const id = String(req.params.file).replace(/\.pdf$/i, "");
  const p = store.pdfPath(id);
  if (!/^[a-z0-9]+$/i.test(id) || !existsSync(p)) return res.status(404).json({ error: "generation not found" });
  const gen = store.getGeneration(id);
  const fname = (gen && gen.output) || id + ".pdf";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fname}"`);
  res.send(readFileSync(p));
});

app.listen(PORT, () => {
  console.log("Panel       http://localhost:" + PORT + "/");
  console.log("API         http://localhost:" + PORT + "/v1/create");
  console.log("Docs        http://localhost:" + PORT + "/docs");
});
