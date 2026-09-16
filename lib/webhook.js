// Envío de webhooks (fire-and-forget). Es la primera salida HTTP del proyecto:
// se dispara al generar un PDF si el usuario configuró un webhook. Nunca lanza
// ni bloquea la generación (try/catch + timeout).
import { createHmac } from "node:crypto";
import { getWebhook, isHttpUrl } from "./settings.js";

const TIMEOUT_MS = 5000;

// Envía { event, ...payload } por POST al webhook configurado. Si hay secret,
// añade la cabecera X-PDFStudio-Signature: sha256=<hmac del body>.
// `override` permite forzar url/secret/enabled (para "Send test").
export async function fire(event, payload = {}, override = null) {
  const cfg = override || getWebhook();
  if (!cfg || !cfg.enabled || !isHttpUrl(cfg.url)) return { ok: false, skipped: true };
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), ...payload });
  const headers = { "Content-Type": "application/json", "User-Agent": "PDFStudio-Webhook/1.0" };
  if (cfg.secret) headers["X-PDFStudio-Signature"] = "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(cfg.url, { method: "POST", headers, body, signal: ctrl.signal });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

// Dispara sin esperar (para no retrasar la respuesta de generación). Loguea fallos.
export function fireAsync(event, payload = {}) {
  fire(event, payload).then((r) => {
    if (!r.ok && !r.skipped) console.warn("[webhook] delivery failed:", r.error || r.status);
  }).catch(() => {});
}
