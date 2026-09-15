import Handlebars from "handlebars";
import puppeteer from "puppeteer";
import QRCode from "qrcode";
import bwipjs from "bwip-js";

// Un solo navegador reutilizado para todas las peticiones (rapido).
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserPromise;
}

// Los valores que llegan como string pero parecen JSON (listas/objetos) se
// convierten a su tipo real, para que {{#each items}} funcione aunque el
// agente mande la lista como texto.
function coerce(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (typeof v === "string") {
      const t = v.trim();
      if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) {
        try {
          out[k] = JSON.parse(t);
          continue;
        } catch {}
      }
    }
    out[k] = v;
  }
  return out;
}

// Formateadores utiles dentro de las plantillas: {{money total}} -> 1.234,56
Handlebars.registerHelper("money", (n) => {
  const num = Number(n);
  if (Number.isNaN(num)) return n;
  return num.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});

// {{multiply cantidad precio}} -> producto numerico
Handlebars.registerHelper("multiply", (a, b) => Number(a) * Number(b));

// Reemplazo asincrono con regex
async function replaceAsync(str, re, fn) {
  const parts = [];
  let last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(str))) {
    parts.push(str.slice(last, m.index));
    parts.push(await fn(...m));
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return parts.join("");
}
function setImgSrc(tag, uri) {
  if (/\bsrc="[^"]*"/.test(tag)) return tag.replace(/\bsrc="[^"]*"/, `src="${uri}"`);
  return tag.replace(/<img\b/, `<img src="${uri}"`);
}

// Convierte <img data-qr="valor"> y <img data-barcode="valor"> en imagenes reales
// (data URI) antes de imprimir. Asi el QR/codigo de barras sale en el PDF.
async function embedCodes(html) {
  html = await replaceAsync(html, /<img\b[^>]*\bdata-qr="([^"]*)"[^>]*>/g, async (tag, value) => {
    try {
      const uri = await QRCode.toDataURL(value || " ", { margin: 1, width: 320 });
      return setImgSrc(tag, uri);
    } catch { return tag; }
  });
  html = await replaceAsync(html, /<img\b[^>]*\bdata-barcode="([^"]*)"[^>]*>/g, async (tag, value) => {
    try {
      const png = await bwipjs.toBuffer({ bcid: "code128", text: value || "000", scale: 3, height: 12, includetext: true, textxalign: "center" });
      return setImgSrc(tag, "data:image/png;base64," + png.toString("base64"));
    } catch { return tag; }
  });
  return html;
}

// Convierte filas repetibles <tr data-each="items">...</tr> en un bloque
// Handlebars {{#each items}}<tr>...</tr>{{/each}}. Esta forma sobrevive al
// editor visual (el navegador no saca texto suelto de dentro de las tablas).
function expandEachRows(html) {
  return html.replace(
    /<tr\b([^>]*?)\sdata-each="([^"]+)"([^>]*)>([\s\S]*?)<\/tr>/g,
    (_, pre, name, post, inner) => `{{#each ${name}}}<tr${pre}${post}>${inner}</tr>{{/each}}`
  );
}

// Bloquea peticiones a destinos internos (anti-SSRF) desde el render.
function isBlockedUrl(u) {
  if (u.startsWith("data:") || u === "about:blank") return false;
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return true; // file:, etc.
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost")) return true;
    if (h === "169.254.169.254" || h === "metadata.google.internal") return true;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true;
    return false;
  } catch {
    return true;
  }
}

// Limita cuantos PDFs se renderizan a la vez (Chromium es costoso -> evita DoS).
const MAX_CONCURRENT = Number(process.env.RENDER_CONCURRENCY || 3);
const RENDER_TIMEOUT = Number(process.env.RENDER_TIMEOUT_MS || 15000);
let active = 0;
const waiters = [];
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) { active++; next(); }
}

export async function renderHtmlToPdf(html, data = {}) {
  const template = Handlebars.compile(expandEachRows(html));
  let filled = template(coerce(data));
  filled = await embedCodes(filled);
  await acquire();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Mitiga SSRF: bloquea destinos internos (metadata cloud, IPs privadas,
    // localhost) y esquemas peligrosos; deja pasar data URIs y recursos publicos.
    await page.setRequestInterception(true);
    page.on("request", (req) => (isBlockedUrl(req.url()) ? req.abort() : req.continue()));
    page.setDefaultTimeout(RENDER_TIMEOUT);
    await page.setContent(filled, { waitUntil: "load", timeout: RENDER_TIMEOUT });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      timeout: RENDER_TIMEOUT,
    });
    return pdf;
  } finally {
    await page.close();
    release();
  }
}

// Renderiza la plantilla a una imagen PNG (miniatura de la parte superior A4).
export async function renderHtmlToImage(html, data = {}) {
  const template = Handlebars.compile(expandEachRows(html));
  let filled = template(coerce(data));
  filled = await embedCodes(filled);
  await acquire();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on("request", (req) => (isBlockedUrl(req.url()) ? req.abort() : req.continue()));
    page.setDefaultTimeout(RENDER_TIMEOUT);
    await page.setContent(filled, { waitUntil: "load", timeout: RENDER_TIMEOUT });
    // Base blanca (evita que el area fuera del contenido salga oscura en el PNG)
    await page.addStyleTag({ content: "html{background:#ffffff !important}" });
    const png = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: 794, height: 1123 },
      omitBackground: false,
    });
    return png;
  } finally {
    await page.close();
    release();
  }
}

// Deriva las variables de la plantilla para exponerlas como inputs del MCP.
// - simple:  {{cliente}}  -> string
// - arrays:  {{#each items}} -> lista (el agente la manda como JSON)
export function extractVars(html) {
  // Normaliza las filas repetibles del editor visual a bloques #each
  html = expandEachRows(html);
  const arrays = new Set();
  const eachRe = /\{\{#each\s+([\w.]+)\s*\}\}/g;
  let m;
  while ((m = eachRe.exec(html))) arrays.add(m[1].split(".")[0]);

  // Quita el contenido de los bloques #each para no capturar campos internos
  const stripped = html.replace(/\{\{#each[\s\S]*?\{\{\/each\}\}/g, "");
  const simple = new Set();
  const reserved = ["this", "else", "each", "if", "unless", "with", "money"];
  const mustacheRe = /\{\{\{?\s*([\w.]+)\s*\}?\}\}/g;
  while ((m = mustacheRe.exec(stripped))) {
    const root = m[1].split(".")[0];
    if (reserved.includes(root)) continue;
    simple.add(root);
  }
  return {
    simple: [...simple].filter((s) => !arrays.has(s)),
    arrays: [...arrays],
  };
}

// Datos de ejemplo para la vista previa: bloque <!--SAMPLE {json} SAMPLE-->
export function extractSample(html) {
  const m = html.match(/<!--\s*SAMPLE([\s\S]*?)SAMPLE\s*-->/);
  if (!m) return {};
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return {};
  }
}
