// Reads a store item list (CSV or Excel) and turns it into products.
// Store exports differ a lot, so this guesses the columns and lets the person fix the guess.

const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
let xlsxPromise = null;
function loadXlsx() {
  if (globalThis.XLSX) return Promise.resolve();
  return (xlsxPromise ||= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = XLSX_URL; s.onload = res;
    s.onerror = () => { xlsxPromise = null; rej(new Error("Couldn't load the Excel reader. Check your connection, or save the file as CSV.")); };
    document.head.appendChild(s);
  }));
}

/* ---------- reading files ---------- */
export function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const counts = { ",": 0, "\t": 0, ";": 0, "|": 0 };
  for (const ch of firstLine) if (ch in counts) counts[ch]++;
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ""));
}

export async function readFile(file) {
  const name = file.name.toLowerCase();
  if (/\.(xlsx|xlsm|xls)$/.test(name)) {
    await loadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // raw:false keeps long UPCs as text instead of 4.13E+10
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
    return rows.map((r) => r.map((v) => String(v ?? "").trim())).filter((r) => r.some((v) => v !== ""));
  }
  return parseCsv(await file.text());
}

/* ---------- columns ---------- */
const PATTERNS = {
  upc: /\b(upc|gtin|ean|bar ?code|scan ?code)\b/i,
  name: /(desc|description|item name|product name|^name$|^item$|product)/i,
  category: /(dept|department|category|class|sub ?dept|section|aisle)/i,
  size: /(size|uom|unit of measure|pack|volume)/i,
};
const digitsOnly = (v) => String(v || "").replace(/[\s-]/g, "");
const looksLikeCode = (v) => /^\d{6,14}$/.test(digitsOnly(v));

export function setup(rows) {
  const first = rows[0] || [];
  const hasHeader = first.some((v) => Object.values(PATTERNS).some((p) => p.test(v))) || first.filter(looksLikeCode).length === 0;
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => (hasHeader && first[i]) || `Column ${i + 1}`);
  const body = hasHeader ? rows.slice(1) : rows;
  const sample = body.slice(0, 200);
  const share = (i, fn) => sample.length ? sample.filter((r) => fn(r[i] || "")).length / sample.length : 0;
  const find = (key, exclude = []) => {
    const byName = headers.findIndex((h, i) => !exclude.includes(i) && hasHeader && PATTERNS[key].test(h));
    return byName;
  };
  let upcCol = find("upc");
  if (upcCol < 0) { let best = -1, bestShare = 0.5; headers.forEach((_, i) => { const s = share(i, looksLikeCode); if (s > bestShare) { best = i; bestShare = s; } }); upcCol = best; }
  let nameCol = find("name", [upcCol]);
  if (nameCol < 0) {
    let best = -1, bestLen = 0;
    headers.forEach((_, i) => { if (i === upcCol) return; const avg = sample.reduce((s, r) => s + (/[a-z]/i.test(r[i] || "") ? (r[i] || "").length : 0), 0) / (sample.length || 1); if (avg > bestLen) { best = i; bestLen = avg; } });
    nameCol = best;
  }
  const categoryCol = find("category", [upcCol, nameCol]);
  const sizeCol = find("size", [upcCol, nameCol, categoryCol]);
  const capsShare = nameCol >= 0 ? share(nameCol, (v) => /[A-Z]/.test(v) && v === v.toUpperCase()) : 0;
  return { headers, body, upcCol, nameCol, categoryCol, sizeCol, fixCaps: capsShare > 0.6, checkMode: "auto", category: "Milk", useCategoryCol: false, shelfDays: 14 };
}

/* ---------- UPC clean-up ---------- */
export function checkDigit(base) {
  let sum = 0;
  for (let i = 0; i < base.length; i++) { const d = +base[base.length - 1 - i]; sum += i % 2 === 0 ? d * 3 : d; }
  return String((10 - (sum % 10)) % 10);
}
export const hasValidCheck = (code) => code.length >= 8 && checkDigit(code.slice(0, -1)) === code.slice(-1);
// Same shape the scanner produces: 12-digit UPC-A, or 13-digit EAN when it isn't a US code.
function toScanForm(full) {
  let s = full.replace(/^0+/, "");
  if (s.length <= 12) return s.padStart(12, "0");
  return s;
}
export function normalizeUpc(raw, withCheck) {
  const d = digitsOnly(raw);
  if (!/^\d{6,14}$/.test(d)) return null;
  if (withCheck) return toScanForm(d);
  const base = d.replace(/^0+/, "");
  if (!base || base.length > 12) return null;
  const padded = base.length <= 11 ? base.padStart(11, "0") : base;
  return toScanForm(padded + checkDigit(padded));
}

/* ---------- names ---------- */
const KEEP_UPPER = new Set(["UHT", "DHA", "A2", "USDA", "NY", "VT", "NJ", "PA", "OJ", "LF", "FF", "ND"]);
export function tidyName(s) {
  return s.toLowerCase().replace(/\b([a-z0-9']+)\b/g, (w) => {
    const up = w.toUpperCase();
    if (KEEP_UPPER.has(up)) return up;
    if (/^\d+(oz|z|ct|lb|qt|pt|gal|ml|l|g)$/i.test(w)) return w.toLowerCase();
    return w[0].toUpperCase() + w.slice(1);
  }).replace(/\s+/g, " ").trim();
}

/* ---------- build the product list ---------- */
export function build(cfg) {
  const { body, upcCol, nameCol, sizeCol, categoryCol } = cfg;
  if (upcCol < 0 || nameCol < 0) return { items: [], skipped: body.length, withCheck: true, dupes: 0 };
  const codes = body.map((r) => digitsOnly(r[upcCol])).filter((d) => /^\d{8,14}$/.test(d));
  const validShare = codes.length ? codes.filter(hasValidCheck).length / codes.length : 1;
  const withCheck = cfg.checkMode === "yes" ? true : cfg.checkMode === "no" ? false : validShare >= 0.8;
  const seen = new Set(), items = [];
  let skipped = 0, dupes = 0;
  for (const r of body) {
    const upc = normalizeUpc(r[upcCol], withCheck);
    let name = (r[nameCol] || "").trim();
    if (!upc || !name) { skipped++; continue; }
    if (seen.has(upc)) { dupes++; continue; }
    seen.add(upc);
    if (cfg.fixCaps) name = tidyName(name);
    const size = sizeCol >= 0 ? (r[sizeCol] || "").trim() : "";
    if (size && !name.toLowerCase().includes(size.toLowerCase())) name += " " + (cfg.fixCaps ? size.toLowerCase() : size);
    const category = cfg.useCategoryCol && categoryCol >= 0 ? (cfg.fixCaps ? tidyName(r[categoryCol] || "") : (r[categoryCol] || "").trim()) || "Uncategorized" : cfg.category || "Uncategorized";
    items.push({ upc, name: name.slice(0, 80), category, shelfDays: cfg.shelfDays });
  }
  return { items, skipped, dupes, withCheck, validShare };
}
