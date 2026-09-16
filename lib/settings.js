// Ajustes del servicio (retención automática, webhook). Se guardan en
// data/settings.json, siguiendo el mismo patrón JSON que lib/store.js.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA = "data";
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
const SETTINGS_FILE = join(DATA, "settings.json");

const DEFAULTS = {
  retentionDays: 0, // 0 = conservar para siempre
  webhook: { enabled: false, url: "", secret: "" },
};

function read() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; }
}
function write(v) { writeFileSync(SETTINGS_FILE, JSON.stringify(v, null, 2)); }

// Devuelve los ajustes fusionados con los valores por defecto.
export function getSettings() {
  const s = read();
  return {
    retentionDays: Number.isFinite(s.retentionDays) ? s.retentionDays : DEFAULTS.retentionDays,
    webhook: { ...DEFAULTS.webhook, ...(s.webhook || {}) },
  };
}

// Aplica un parche parcial y persiste. Valida/normaliza los campos conocidos.
export function patchSettings(partial = {}) {
  const cur = getSettings();
  if (partial.retentionDays !== undefined) {
    const n = Math.floor(Number(partial.retentionDays));
    cur.retentionDays = Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (partial.webhook !== undefined) {
    const w = partial.webhook || {};
    if (w.enabled !== undefined) cur.webhook.enabled = !!w.enabled;
    if (w.url !== undefined) cur.webhook.url = String(w.url || "").trim();
    if (w.secret !== undefined) cur.webhook.secret = String(w.secret || "");
    // Un webhook sin URL válida no puede quedar habilitado.
    if (!isHttpUrl(cur.webhook.url)) cur.webhook.enabled = false;
  }
  write(cur);
  return cur;
}

export function getRetentionDays() { return getSettings().retentionDays; }
export function getWebhook() { return getSettings().webhook; }

export function isHttpUrl(u) {
  try { const p = new URL(String(u)); return p.protocol === "http:" || p.protocol === "https:"; }
  catch { return false; }
}
