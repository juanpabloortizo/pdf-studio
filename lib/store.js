// Persistencia en disco (vive en data/, montado como volumen en Docker).
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const DATA = "data";
const PDFS = join(DATA, "pdfs");
const VERSIONS = join(DATA, "versions");
for (const d of [DATA, PDFS, VERSIONS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

const APIKEY_FILE = join(DATA, "apikey.json");
const HISTORY_FILE = join(DATA, "history.json");
const TPLMETA_FILE = join(DATA, "templates.json");
const SHARES_FILE = join(DATA, "shares.json");
const MAX_HISTORY = 300;
const MAX_VERSIONS = 30; // versiones guardadas por plantilla

function readJson(f, fallback) {
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; }
}
function writeJson(f, v) { writeFileSync(f, JSON.stringify(v, null, 2)); }
function genKey() { return "pdfk_" + randomBytes(24).toString("base64url"); }
function genId() { return Date.now().toString(36) + randomBytes(3).toString("hex"); }

// ---- API key ----
export function getApiKey(seed) {
  let cfg = readJson(APIKEY_FILE, null);
  if (!cfg || !cfg.key) {
    cfg = { key: seed || genKey(), updatedAt: new Date().toISOString(), logRequests: true };
    writeJson(APIKEY_FILE, cfg);
  }
  return cfg;
}
export function resetApiKey() {
  const prev = getApiKey();
  const cfg = { key: genKey(), updatedAt: new Date().toISOString(), logRequests: prev.logRequests };
  writeJson(APIKEY_FILE, cfg);
  return cfg;
}
export function setLogRequests(v) {
  const cfg = getApiKey();
  cfg.logRequests = !!v; cfg.updatedAt = new Date().toISOString();
  writeJson(APIKEY_FILE, cfg);
  return cfg;
}

// ---- Historial de PDFs generados ----
export function logGeneration({ template_id, source, pdf, output }) {
  const id = genId();
  const bytes = pdf ? pdf.length : 0;
  if (pdf) writeFileSync(join(PDFS, id + ".pdf"), pdf);
  const hist = readJson(HISTORY_FILE, []);
  hist.unshift({ id, template_id, source, bytes, output: output || null, createdAt: new Date().toISOString() });
  // borra los pdf que se caen del tope
  for (const old of hist.slice(MAX_HISTORY)) {
    try { unlinkSync(join(PDFS, old.id + ".pdf")); } catch {}
  }
  writeJson(HISTORY_FILE, hist.slice(0, MAX_HISTORY));
  return id;
}
export function getHistory(limit = 300) { return readJson(HISTORY_FILE, []).slice(0, limit); }
export function getGeneration(id) { return readJson(HISTORY_FILE, []).find((h) => h.id === id) || null; }
export function pdfPath(id) { return join(PDFS, id + ".pdf"); }
// Borra una generación (registro + su PDF). Devuelve true si existía.
export function deleteGeneration(id) {
  const hist = readJson(HISTORY_FILE, []);
  const idx = hist.findIndex((h) => h.id === id);
  if (idx === -1) return false;
  hist.splice(idx, 1);
  writeJson(HISTORY_FILE, hist);
  try { unlinkSync(join(PDFS, id + ".pdf")); } catch {}
  pruneShares(new Set([id]));
  return true;
}
// Borra varias (o todas si ids es vacío/null). Devuelve cuántas borró.
export function deleteGenerations(ids) {
  const hist = readJson(HISTORY_FILE, []);
  const set = ids && ids.length ? new Set(ids) : null;
  const keep = [];
  const removedIds = new Set();
  for (const h of hist) {
    if (!set || set.has(h.id)) { try { unlinkSync(join(PDFS, h.id + ".pdf")); } catch {} removedIds.add(h.id); }
    else keep.push(h);
  }
  writeJson(HISTORY_FILE, keep);
  pruneShares(removedIds);
  return removedIds.size;
}
// Retención automática: borra generaciones (registro + PDF) más viejas que N días.
// days<=0 no hace nada. Devuelve cuántas borró.
export function pruneOlderThan(days) {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const cutoff = Date.now() - n * 86400 * 1000;
  const hist = readJson(HISTORY_FILE, []);
  const keep = [];
  const removedIds = new Set();
  for (const h of hist) {
    const t = new Date(h.createdAt || 0).getTime();
    if (t && t < cutoff) { try { unlinkSync(join(PDFS, h.id + ".pdf")); } catch {} removedIds.add(h.id); }
    else keep.push(h);
  }
  if (removedIds.size) { writeJson(HISTORY_FILE, keep); pruneShares(removedIds); }
  return removedIds.size;
}
// ---- Enlaces compartibles (públicos, sin API key) ----
// data/shares.json = { [token]: { id, createdAt, expiresAt|null } }
// expiresAt null = permanente.
export function createShare(genId, ttlSeconds) {
  const shares = readJson(SHARES_FILE, {});
  const token = randomBytes(16).toString("base64url");
  const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
  shares[token] = { id: genId, createdAt: new Date().toISOString(), expiresAt };
  writeJson(SHARES_FILE, shares);
  return { token, expiresAt };
}
// Devuelve el share si es válido (existe y no expiró); borra los expirados al vuelo.
export function resolveShare(token) {
  const shares = readJson(SHARES_FILE, {});
  const s = shares[token];
  if (!s) return null;
  if (s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()) {
    delete shares[token]; writeJson(SHARES_FILE, shares); return null;
  }
  return s;
}
export function revokeShare(token) {
  const shares = readJson(SHARES_FILE, {});
  if (!shares[token]) return false;
  delete shares[token]; writeJson(SHARES_FILE, shares); return true;
}
// Borra los enlaces que apuntan a generaciones ya eliminadas.
function pruneShares(idSet) {
  const shares = readJson(SHARES_FILE, {});
  let changed = false;
  for (const [t, s] of Object.entries(shares)) if (idSet.has(s.id)) { delete shares[t]; changed = true; }
  if (changed) writeJson(SHARES_FILE, shares);
}

export function stats() {
  const hist = readJson(HISTORY_FILE, []);
  const today = new Date().toISOString().slice(0, 10);
  const bytes = hist.reduce((a, h) => a + (h.bytes || 0), 0);
  return {
    total: hist.length,
    today: hist.filter((h) => (h.createdAt || "").slice(0, 10) === today).length,
    bytes,
  };
}

// ---- Registro de plantillas (cada una con un UUID estable) ----
// data/templates.json = { [name]: { id, createdAt, updatedAt } }
function readMeta() { return readJson(TPLMETA_FILE, {}); }
function writeMeta(m) { writeJson(TPLMETA_FILE, m); }

// Asegura que la plantilla tenga id; lo crea la primera vez.
export function ensureTemplateMeta(name) {
  const m = readMeta();
  if (!m[name]) {
    const now = new Date().toISOString();
    m[name] = { id: "tpl_" + randomUUID(), createdAt: now, updatedAt: now };
    writeMeta(m);
  }
  return m[name]; // createdAt es estable; la "última actualización" real es el mtime del archivo
}
export function templateMeta(name) { return readMeta()[name] || null; }
export function allTemplateMeta() { return readMeta(); }
export function removeTemplateMeta(name) { const m = readMeta(); delete m[name]; writeMeta(m); removeVersions(name); }
export function renameTemplateMeta(from, to) {
  const m = readMeta();
  if (m[from]) { m[to] = m[from]; delete m[from]; writeMeta(m); }
  try { if (existsSync(versionDir(from))) { mkdirSync(versionDir(to), { recursive: true }); for (const f of readdirSync(versionDir(from))) writeFileSync(join(versionDir(to), f), readFileSync(join(versionDir(from), f))); rmSync(versionDir(from), { recursive: true, force: true }); } } catch {}
}

// ---- Historial de versiones de plantillas ----
// data/versions/<name>/<timestamp>.html — snapshot del contenido ANTERIOR a cada
// guardado. Se conservan las últimas MAX_VERSIONS por plantilla.
const safeVer = (n) => /^[a-z0-9_-]+$/i.test(n);
function versionDir(name) { return join(VERSIONS, name); }
// Guarda `prevHtml` como una versión. No guarda si es idéntica a la más reciente.
export function snapshotVersion(name, prevHtml) {
  if (!safeVer(name) || prevHtml == null) return null;
  const dir = versionDir(name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const nums = readdirSync(dir).filter((f) => /^\d+\.html$/.test(f)).map((f) => Number(f.replace(/\.html$/, ""))).sort((a, b) => a - b);
  const lastNum = nums[nums.length - 1];
  if (lastNum) { try { if (readFileSync(join(dir, lastNum + ".html"), "utf8") === prevHtml) return null; } catch {} }
  // ts estrictamente creciente: evita colisiones cuando hay varios guardados en el mismo ms.
  const ts = String(Math.max(Date.now(), (lastNum || 0) + 1));
  writeFileSync(join(dir, ts + ".html"), prevHtml, "utf8");
  // Poda: conserva solo las MAX_VERSIONS más recientes.
  const all = readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
  for (const f of all.slice(0, Math.max(0, all.length - MAX_VERSIONS))) { try { unlinkSync(join(dir, f)); } catch {} }
  return ts;
}
export function listVersions(name) {
  if (!safeVer(name)) return [];
  const dir = versionDir(name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => {
    const ts = f.replace(/\.html$/, "");
    let size = 0; try { size = readFileSync(join(dir, f)).length; } catch {}
    return { ts, size, createdAt: new Date(Number(ts)).toISOString() };
  }).sort((a, b) => Number(b.ts) - Number(a.ts));
}
export function getVersion(name, ts) {
  if (!safeVer(name) || !/^\d+$/.test(String(ts))) return null;
  const f = join(versionDir(name), ts + ".html");
  try { return readFileSync(f, "utf8"); } catch { return null; }
}
export function removeVersions(name) {
  if (!safeVer(name)) return;
  try { rmSync(versionDir(name), { recursive: true, force: true }); } catch {}
}
// Resuelve un template_id (UUID) o un nombre -> nombre de archivo
export function resolveTemplateName(idOrName, nameExists) {
  if (nameExists(idOrName)) return idOrName;      // vino el nombre directo
  const m = readMeta();
  for (const [name, meta] of Object.entries(m)) if (meta.id === idOrName) return name;
  return null;
}
