// Gestión de múltiples API keys: cada una con nombre, expiración y scopes.
// Se guarda en data/apikeys.json. Migra automáticamente la key única antigua
// (data/apikey.json) a una key "Default" con todos los permisos y sin caducar,
// para no romper integraciones existentes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const DATA = "data";
const KEYS_FILE = join(DATA, "apikeys.json");
const LEGACY_FILE = join(DATA, "apikey.json");

// Permisos disponibles (cada endpoint /v1 exige uno).
export const SCOPES = [
  "pdf:create",          // POST /v1/create  (generar PDFs)
  "templates:read",      // GET  /v1/templates(/:id)
  "templates:write",     // DELETE /v1/templates/:id
  "generations:read",    // GET  /v1/generations(/:file)
  "generations:write",   // DELETE generación · crear/revocar enlaces compartibles
];

function readAll() { try { return JSON.parse(readFileSync(KEYS_FILE, "utf8")); } catch { return null; } }
function writeAll(v) { writeFileSync(KEYS_FILE, JSON.stringify(v, null, 2)); }
function genSecret() { return "pdfk_" + randomBytes(24).toString("base64url"); }
function isExpired(k) { return !!(k.expiresAt && new Date(k.expiresAt).getTime() < Date.now()); }
function mask(key) { return key && key.length > 14 ? key.slice(0, 9) + "…" + key.slice(-4) : "••••"; }
const pub = (k) => ({
  id: k.id, name: k.name, scopes: k.scopes, createdAt: k.createdAt,
  expiresAt: k.expiresAt, lastUsedAt: k.lastUsedAt, masked: mask(k.key), expired: isExpired(k),
  rateLimit: k.rateLimit || null, // peticiones/min; null = sin límite
});
// Normaliza un rateLimit: entero positivo o null.
function normRate(v) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; }

// Crea el almacén si no existe, sembrando la key antigua/env como "Default".
function ensureStore(seedKey) {
  const cur = readAll();
  if (cur && Array.isArray(cur.keys)) return cur;
  let legacyKey = seedKey;
  try { const lg = JSON.parse(readFileSync(LEGACY_FILE, "utf8")); if (lg && lg.key) legacyKey = lg.key; } catch {}
  const store = { keys: [{
    id: randomUUID(), name: "Default", key: legacyKey || genSecret(),
    scopes: [...SCOPES], createdAt: new Date().toISOString(), expiresAt: null, lastUsedAt: null,
  }] };
  writeAll(store);
  return store;
}

export function init(seedKey) { ensureStore(seedKey); }
export function listKeys() { return ensureStore().keys.map(pub); }

// Crea una key nueva. ttlDays: número de días o null (= nunca expira).
// Devuelve la vista pública + el secreto completo UNA sola vez.
export function createKey({ name, scopes, ttlDays, rateLimit } = {}) {
  const store = ensureStore();
  const secret = genSecret();
  const now = Date.now();
  const valid = (Array.isArray(scopes) ? scopes : []).filter((s) => SCOPES.includes(s));
  const key = {
    id: randomUUID(),
    name: String(name || "Untitled").trim().slice(0, 60) || "Untitled",
    key: secret,
    scopes: valid.length ? valid : [...SCOPES],
    createdAt: new Date(now).toISOString(),
    expiresAt: ttlDays ? new Date(now + ttlDays * 864e5).toISOString() : null,
    lastUsedAt: null,
    rateLimit: normRate(rateLimit),
  };
  store.keys.push(key);
  writeAll(store);
  return { ...pub(key), key: secret };
}

// Actualiza campos editables de una key (por ahora solo rateLimit).
export function updateKey(id, { rateLimit } = {}) {
  const store = ensureStore();
  const k = store.keys.find((x) => x.id === id);
  if (!k) return null;
  if (rateLimit !== undefined) k.rateLimit = normRate(rateLimit);
  writeAll(store);
  return pub(k);
}

export function revokeKey(id) {
  const store = ensureStore();
  const i = store.keys.findIndex((k) => k.id === id);
  if (i === -1) return false;
  store.keys.splice(i, 1);
  writeAll(store);
  return true;
}

// Rate limit por key (ventana fija de 60 s, en memoria). Devuelve true si la
// petición está permitida, false si excede el límite. limitPerMin null = sin tope.
const rateBuckets = new Map(); // keyId -> { windowStart, count }
export function checkRate(keyId, limitPerMin) {
  const limit = normRate(limitPerMin);
  if (!limit) return true;
  const now = Date.now();
  let b = rateBuckets.get(keyId);
  if (!b || now - b.windowStart >= 60000) { b = { windowStart: now, count: 0 }; rateBuckets.set(keyId, b); }
  b.count++;
  return b.count <= limit;
}

// Autentica por el secreto (comparación en tiempo constante), valida expiración
// y refresca lastUsedAt (como mucho una vez por minuto). Devuelve el registro o null.
export function authenticate(secret) {
  if (!secret) return null;
  const store = ensureStore();
  const sb = Buffer.from(String(secret));
  let found = null;
  for (const k of store.keys) {
    const kb = Buffer.from(k.key);
    if (kb.length === sb.length && timingSafeEqual(kb, sb)) { found = k; break; }
  }
  if (!found || isExpired(found)) return null;
  const nowMs = Date.now();
  if (!found.lastUsedAt || nowMs - new Date(found.lastUsedAt).getTime() > 60000) {
    found.lastUsedAt = new Date(nowMs).toISOString();
    writeAll(store);
  }
  return found;
}
