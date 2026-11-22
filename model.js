// Date math and the sell-through model. Shared by the app and the daily alert sender.
//
// Every restock replaces units that sold, so restocks over time give a sales rate.
// Units still out = everything stocked minus estimated sales. Oldest dates sell first,
// so the units still out are the newest dates. Older batches with nothing left are
// "likely sold through" and drop off the check list.

export const DAY = 864e5;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
export const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / DAY);
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const dateCode = (s) => { const d = parseYmd(s); return MONTHS[d.getMonth()] + " " + String(d.getDate()).padStart(2, "0"); };
export const shortDate = (ms) => { const d = new Date(ms); const m = MONTHS[d.getMonth()]; return m[0] + m.slice(1).toLowerCase() + " " + d.getDate(); };
export const whenText = (dl) =>
  dl < -1 ? `Expired ${-dl} days ago` : dl === -1 ? "Expired yesterday" : dl === 0 ? "Expires today" : dl === 1 ? "Expires tomorrow" : `Expires in ${dl} days`;

export const isOpen = (b) => b.status === "open" || b.status === "marked";

export function model(batches, now = Date.now()) {
  const ev = [];
  batches.forEach((b) => (b.events || []).forEach((e) => ev.push(e)));
  ev.sort((a, b) => a.at - b.at);
  const m = { learning: true, rate: null, restocks: ev.length, span: 0, likelySold: new Set(), est: {} };
  if (ev.length) m.span = (ev[ev.length - 1].at - ev[0].at) / DAY;
  if (ev.length < 3 || m.span < 2) return m;
  const rate = ev.slice(1).reduce((s, e) => s + (e.qty || 0), 0) / m.span;
  const total = ev.reduce((s, e) => s + (e.qty || 0), 0);
  const sold = rate * ((now - ev[0].at) / DAY) * 0.85; // lean toward alerting rather than missing
  let left = Math.max(0, total - sold);
  const open = batches.filter(isOpen).sort((a, b) => (a.exp < b.exp ? 1 : a.exp > b.exp ? -1 : 0));
  for (const b of open) {
    const k = Math.min(b.qty || 0, left);
    left -= k;
    m.est[b.id] = Math.round(k);
    const seenRecently = b.seenAt && now - b.seenAt < DAY;
    if (k < 0.5 && !seenRecently) m.likelySold.add(b.id);
  }
  m.learning = false;
  m.rate = rate;
  return m;
}

export const emptyModel = () => ({ learning: true, rate: null, restocks: 0, span: 0, likelySold: new Set(), est: {} });

export function models(batches, now = Date.now()) {
  const by = {};
  batches.forEach((b) => (by[b.upc] ||= []).push(b));
  const out = {};
  for (const u in by) out[u] = model(by[u], now);
  return out;
}

// today: "YYYY-MM-DD" in the store's local time.
export function analyze({ batches, products, settings, today, now = Date.now() }) {
  const ms = models(batches, now);
  const rows = [];
  for (const b of batches) {
    if (!isOpen(b)) continue;
    const p = products[b.upc] || { name: "Unknown item", category: "Uncategorized" };
    const m = ms[b.upc] || emptyModel();
    const dl = daysBetween(today, b.exp);
    const likely = m.likelySold.has(b.id);
    let level = null;
    if (dl <= settings.pullDays) level = "pull";
    else if (dl <= settings.markdownDays && b.status === "open") level = "markdown";
    else if (dl <= settings.markdownDays + 3) level = "soon";
    rows.push({ b, p, m, dl, level, likely });
  }
  rows.sort((a, b) => a.dl - b.dl || a.p.name.localeCompare(b.p.name));
  return { rows, ms };
}

export const needsAction = (r) => (r.level === "pull" || r.level === "markdown") && !r.likely;
