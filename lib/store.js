// Persistencia en disco (vive en data/, montado como volumen en Docker).
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const DATA = "data";
const PDFS = join(DATA, "pdfs");
for (const d of [DATA, PDFS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

const APIKEY_FILE = join(DATA, "apikey.json");
const HISTORY_FILE = join(DATA, "history.json");
const TPLMETA_FILE = join(DATA, "templates.json");
const MAX_HISTORY = 300;

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
  return true;
}
// Borra varias (o todas si ids es vacío/null). Devuelve cuántas borró.
export function deleteGenerations(ids) {
  const hist = readJson(HISTORY_FILE, []);
  const set = ids && ids.length ? new Set(ids) : null;
  const keep = [];
  let removed = 0;
  for (const h of hist) {
    if (!set || set.has(h.id)) { try { unlinkSync(join(PDFS, h.id + ".pdf")); } catch {} removed++; }
    else keep.push(h);
  }
  writeJson(HISTORY_FILE, keep);
  return removed;
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
export function removeTemplateMeta(name) { const m = readMeta(); delete m[name]; writeMeta(m); }
export function renameTemplateMeta(from, to) {
  const m = readMeta();
  if (m[from]) { m[to] = m[from]; delete m[from]; writeMeta(m); }
}
// Resuelve un template_id (UUID) o un nombre -> nombre de archivo
export function resolveTemplateName(idOrName, nameExists) {
  if (nameExists(idOrName)) return idOrName;      // vino el nombre directo
  const m = readMeta();
  for (const [name, meta] of Object.entries(m)) if (meta.id === idOrName) return name;
  return null;
}
