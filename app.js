import { configured, supabaseBackend, demoBackend } from "./data.js";
import { VAPID_PUBLIC_KEY } from "./config.js";
import { scanBarcode } from "./scanner.js";
import * as importer from "./importer.js";
import { DAY, analyze, models, emptyModel, isOpen, needsAction, addDays, daysBetween, dateCode, whenText, shortDate } from "./model.js";

const S = {
  backend: null, session: null, screen: "loading", authMode: "signin", stores: [], store: null,
  products: {}, batches: [], offlineSince: null, loaded: false,
  tab: "check", cat: "All", flow: { step: "scan" }, editUpc: null, showLikely: false, fresh: true, alerts: "unknown",
};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
};
const normUpc = (s) => { let d = String(s || "").replace(/\D/g, ""); if (d.length === 13 && d[0] === "0") d = d.slice(1); return d; };
const productOf = (upc) => S.products[upc] || { name: "Unknown item", category: "Uncategorized" };
const settings = () => ({ markdownDays: S.store?.markdownDays ?? 2, pullDays: S.store?.pullDays ?? 0 });
function dayOf(ms) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: S.store?.timezone || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)); }
  catch (e) { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
}
const today = () => dayOf(Date.now());
// "Pass" = someone checked it today and left it on the shelf. It comes back tomorrow.
const passedToday = (b) => b.passedOn === today();
const daysLeft = (exp) => daysBetween(today(), exp);
const analysis = () => analyze({ batches: S.batches, products: S.products, settings: settings(), today: today() });
const canEditStore = () => S.store?.role === "owner";

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3000);
}
async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); await refresh(); return true; }
  catch (e) { toast((e && e.message) || "Couldn't save. Try again."); return false; }
}

/* ================= boot & auth ================= */
async function boot() {
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  if (!configured) {
    if (store.get("sdt-mode") === "demo") return startDemo();
    S.screen = "setup"; return render();
  }
  try { S.backend = await supabaseBackend(); }
  catch (e) { S.screen = "error"; S.error = "The app couldn't start. Check your connection and reopen it."; return render(); }
  S.session = await S.backend.session();
  S.backend.onAuth((s) => { const was = Boolean(S.session); S.session = s; if (Boolean(s) !== was) afterAuth(); });
  afterAuth();
}
function startDemo() {
  store.set("sdt-mode", "demo");
  S.backend = demoBackend(); S.session = { demo: true };
  afterAuth();
}
async function afterAuth() {
  if (!S.session) { S.screen = "auth"; S.fresh = true; return render(); }
  try { S.stores = await S.backend.myStores(); }
  catch (e) {
    const cached = readCache(store.get("sdt-store"));
    if (cached) { S.store = cached.store; S.stores = [cached.store]; return enterStore(); }
    S.screen = "error"; S.error = e.message; return render();
  }
  if (!S.stores.length) { S.screen = "pickStore"; S.fresh = true; return render(); }
  S.store = S.stores.find((s) => s.id === store.get("sdt-store")) || S.stores[0];
  enterStore();
}
async function enterStore() {
  store.set("sdt-store", S.store.id);
  S.screen = "app"; S.fresh = true;
  await refresh();
  S.backend.watch(S.store, refresh);
  checkAlerts();
}
const cacheKey = (id) => "sdt-cache-" + id;
function readCache(id) { try { return id ? JSON.parse(store.get(cacheKey(id))) : null; } catch (e) { return null; } }
async function refresh() {
  if (!S.store) return;
  try {
    const d = await S.backend.load(S.store);
    S.products = d.products; S.batches = d.batches; S.store = { ...S.store, ...d.store };
    S.offlineSince = null; S.loaded = true;
    if (S.backend.kind !== "demo") store.set(cacheKey(S.store.id), JSON.stringify({ ...d, savedAt: Date.now() }));
  } catch (e) {
    const c = readCache(S.store.id);
    if (c) { S.products = c.products; S.batches = c.batches; S.offlineSince = c.savedAt; S.loaded = true; }
    else S.offlineSince = S.offlineSince || Date.now();
  }
  render();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.screen === "app") refresh(); });

/* ================= rendering ================= */
function render() {
  const keep = {};
  if (!S.fresh) document.querySelectorAll("#view input, #view select").forEach((i) => { if (i.id) keep[i.id] = i.value; });
  const focusId = document.activeElement && document.activeElement.id;
  S.fresh = false;
  const inApp = S.screen === "app";
  document.body.classList.toggle("in-app", inApp);
  let html;
  if (S.screen === "loading") html = `<div class="empty"><div class="big-code">.. ..</div><p class="hint">Opening…</p></div>`;
  else if (S.screen === "setup") html = setupView();
  else if (S.screen === "auth") html = authView();
  else if (S.screen === "pickStore") html = pickStoreView();
  else if (S.screen === "error") html = `<div class="empty"><p><strong>Something went wrong.</strong></p><p class="hint">${esc(S.error)}</p><button class="btn primary" data-act="reload">Try again</button></div>`;
  else html = banner() + ({ check: checkView, stock: stockView, products: productsView, results: resultsView, store: storeView }[S.tab])();
  $("#view").innerHTML = html;
  for (const id in keep) { const el = document.getElementById(id); if (el) el.value = keep[id]; }
  if (focusId) { const el = document.getElementById(focusId); if (el && el.tagName === "INPUT") el.focus(); }
  $("#tabs").hidden = !inApp;
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-current", t.dataset.tab === S.tab ? "page" : "false"));
  if (inApp && S.loaded) {
    const n = analysis().rows.filter((r) => needsAction(r) && !passedToday(r.b)).length;
    $("#badge").hidden = n === 0; $("#badge").textContent = n;
    $("#sub").textContent = (S.store?.name || "") + (n ? ` · ${n} to check` : " · All clear");
  } else { $("#badge").hidden = true; $("#sub").textContent = inApp ? S.store?.name || "" : ""; }
}
function go(tab) { S.tab = tab; S.fresh = true; if (tab === "stock") S.flow = { step: "scan" }; render(); window.scrollTo(0, 0); }
function banner() {
  let h = "";
  if (S.backend?.kind === "demo") h += `<div class="banner info">Demo mode: items are saved only on this phone.</div>`;
  if (S.offlineSince) h += `<div class="banner">${S.loaded ? `No connection. Showing items as of ${new Date(S.offlineSince).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Changes won't save until you're back online.` : "No connection. Items will show once you're back online."}</div>`;
  return h;
}

/* ---------- sign-in screens ---------- */
function setupView() {
  return `<div class="hero-card">
      <div class="big-code">NOV 28</div>
      <h2>Shelf Date Tracker</h2>
      <p class="hint">Log expiration dates as you stock. Get a daily list of what to mark down or pull. Restocking teaches it what already sold.</p>
    </div>
    <div class="card">
      <p><strong>This copy isn't connected to a database yet.</strong></p>
      <p class="hint">To share items with coworkers and get daily alerts, finish the steps in SETUP.md. Until then you can try everything in demo mode.</p>
      <button class="btn primary big" data-act="demo">Try demo mode</button>
    </div>`;
}
function authView() {
  const up = S.authMode === "signup";
  return `<div class="hero-card"><div class="big-code">NOV 28</div><h2>${up ? "Create your account" : "Sign in"}</h2>
      <p class="hint">${up ? "Use your own email. Your manager will give you a store code next." : "Shelf Date Tracker"}</p></div>
    <form class="card" id="auth-form">
      <div class="field"><label for="au-email">Email</label><input id="au-email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="au-pass">Password</label><input id="au-pass" type="password" autocomplete="${up ? "new-password" : "current-password"}" minlength="6" required></div>
      <button class="btn primary big" type="submit">${up ? "Create account" : "Sign in"}</button>
      <button class="linkbtn" type="button" data-act="auth-mode">${up ? "Already have an account? Sign in" : "New here? Create an account"}</button>
    </form>`;
}
function pickStoreView() {
  return `<h2>Join your store</h2>
    <div class="card">
      <div class="field"><label for="js-code">Store code</label><input id="js-code" autocomplete="off" autocapitalize="characters" placeholder="6 letters and numbers" maxlength="6"></div>
      <p class="hint">Your manager or whoever set up the tracker can find it on their Store tab.</p>
      <button class="btn primary big" data-act="join">Join store</button>
    </div>
    <h3>Or start a new one</h3>
    <div class="card">
      <div class="field"><label for="cs-name">Store or department name</label><input id="cs-name" autocomplete="off" placeholder="e.g. Store 214 Dairy"></div>
      <button class="btn big" data-act="create-store">Start a new store</button>
    </div>
    ${S.store ? `<button class="linkbtn" data-act="back-app">Back to ${esc(S.store.name)}</button>` : ""}
    ${S.backend?.kind === "supabase" ? `<button class="linkbtn" data-act="signout">Sign out</button>` : ""}`;
}

/* ---------- shared pieces ---------- */
function catChips() {
  const cats = [...new Set(Object.values(S.products).map((p) => p.category || "Uncategorized"))].sort();
  if (cats.length < 2) return "";
  return `<div class="chips">${["All", ...cats].map((c) => `<button class="chip" data-act="cat" data-cat="${esc(c)}" aria-pressed="${S.cat === c}">${esc(c)}</button>`).join("")}</div>`;
}
const inCat = (p) => S.cat === "All" || (p.category || "Uncategorized") === S.cat;

function batchCard(r, kind) {
  const { b, p, m, dl } = r;
  const est = m.est[b.id];
  const bits = [whenText(dl), `${b.qty || 0} stocked`];
  if (!m.learning && est != null) bits.push(`about ${est} left`);
  const tag = kind === "pull" ? `<span class="tag pull">Pull</span>` : kind === "markdown" ? `<span class="tag markdown">Mark down</span>` : kind === "passed" ? `<span class="tag ok">Passed</span>` : b.status === "marked" ? `<span class="tag marked">Marked down</span>` : kind === "likely" ? `<span class="tag ok">Likely sold</span>` : "";
  const takeOff = (alert) => `<button class="btn ${alert === "pull" ? "pull" : ""}" data-act="close" data-id="${b.id}" data-outcome="pulled" data-alert="${alert}">Taken off</button>`;
  const pass = `<button class="btn" data-act="pass" data-id="${b.id}">Pass</button>`;
  const sold = (alert) => `<button class="btn" data-act="close" data-id="${b.id}" data-outcome="gone" data-alert="${alert}">Already sold</button>`;
  let acts = "";
  if (kind === "pull") acts = takeOff("pull") + pass + sold("pull");
  else if (kind === "markdown") acts = `<button class="btn mark" data-act="mark" data-id="${b.id}">Marked down</button>` + takeOff("markdown") + pass + sold("markdown");
  else if (kind === "soon") acts = takeOff("") + pass;
  else if (kind === "passed") acts = `<button class="btn" data-act="unpass" data-id="${b.id}">Undo pass</button>`;
  else if (kind === "likely") acts = `<button class="btn" data-act="close" data-id="${b.id}" data-outcome="gone" data-via="confirm">Confirm sold</button><button class="btn" data-act="seen" data-id="${b.id}">Still on shelf</button>`;
  return `<article class="item ${kind}"><div class="code">${dateCode(b.exp)}</div><div class="info"><div class="name">${tag}${esc(p.name)}</div><div class="meta">${esc(bits.join(" · "))}</div></div>${acts ? `<div class="actions">${acts}</div>` : ""}</article>`;
}
const notLoaded = () => `<div class="empty"><div class="big-code">.. ..</div><p class="hint">Loading items…</p></div>`;

/* ---------- Check ---------- */
function checkView() {
  if (!S.loaded) return notLoaded();
  if (!S.batches.length) {
    return `<div class="empty"><div class="big-code">NOV 28</div><p><strong>Nothing on the shelf yet.</strong></p><p class="hint">Log each date as you stock it. Items close to their date show up here to mark down or pull.</p><button class="btn primary" data-act="tab" data-tab="stock">Stock the first item</button></div>`;
  }
  const all = analysis().rows.filter((r) => inCat(r.p));
  const passed = all.filter((r) => r.level && passedToday(r.b));
  const vis = all.filter((r) => !passedToday(r.b));
  const pull = vis.filter((r) => r.level === "pull" && !r.likely);
  const mark = vis.filter((r) => r.level === "markdown" && !r.likely);
  const soon = vis.filter((r) => r.level === "soon" && !r.likely);
  const likely = vis.filter((r) => r.likely && r.level);
  let h = catChips();
  if (!pull.length && !mark.length) h += `<div class="empty"><div class="big-code">ALL OK</div><p><strong>Nothing to check right now.</strong></p><p class="hint">No dates on the shelf are inside the markdown window.</p></div>`;
  if (pull.length) h += `<section class="section"><h3>Pull today <span class="n">${pull.length}</span></h3>${pull.map((r) => batchCard(r, "pull")).join("")}</section>`;
  if (mark.length) h += `<section class="section"><h3>Mark down <span class="n">${mark.length}</span></h3>${mark.map((r) => batchCard(r, "markdown")).join("")}</section>`;
  if (soon.length) h += `<section class="section"><h3>Coming up <span class="n">${soon.length}</span></h3>${soon.map((r) => batchCard(r, "soon")).join("")}</section>`;
  if (passed.length) h += `<section class="section"><h3>Checked today <span class="n">${passed.length}</span></h3><p class="hint">Passed today and left on the shelf. They come back tomorrow if they still need attention.</p>${passed.map((r) => batchCard(r, "passed")).join("")}</section>`;
  if (likely.length) {
    h += `<section class="section"><h3>Likely sold through <span class="n">${likely.length}</span></h3><p class="hint">Restocking shows these dates probably sold before they got close, so they aren't on your list. Confirm if you pass by, or tap Still on shelf if you see one.</p>`;
    h += S.showLikely ? likely.map((r) => batchCard(r, "likely")).join("") + `<button class="linkbtn" data-act="likely">Hide</button>` : `<button class="linkbtn" data-act="likely">Show ${likely.length}</button>`;
    h += `</section>`;
  }
  return h;
}

/* ---------- Stock ---------- */
function stockView() {
  if (!S.loaded) return notLoaded();
  const f = S.flow;
  if (f.step === "scan") {
    const recent = Object.entries(S.products).filter(([, p]) => inCat(p)).sort((a, b) => (b[1].lastStockedAt || 0) - (a[1].lastStockedAt || 0)).slice(0, 12);
    return `<h2>Stock an item</h2>
      <div class="card">
        <button class="btn primary big" data-act="scan">Scan barcode</button>
        <div class="field"><label for="upc">Or type the UPC</label>
          <div class="row"><input id="upc" inputmode="numeric" autocomplete="off" placeholder="Barcode number"><button class="btn" data-act="upc-go">Next</button></div></div>
        <p class="hint">A Bluetooth barcode scanner works too: tap the UPC box, then scan.</p>
      </div>
      ${recent.length ? `<section class="section"><h3>Recent</h3>${catChips()}<div class="list">${recent.map(([u, p]) => `<button class="prow" data-act="pick" data-upc="${esc(u)}"><span class="info"><span class="name">${esc(p.name)}</span><br><span class="upc">${esc(u)}</span></span><span class="right">${esc(p.category || "")}</span></button>`).join("")}</div></section>` : ""}`;
  }
  if (f.step === "new") {
    const cats = [...new Set(Object.values(S.products).map((p) => p.category).filter(Boolean))];
    const defCat = S.cat !== "All" ? S.cat : cats[0] || "Milk";
    return `<h2>New product</h2>
      <div class="card">
        <p class="hint">UPC <span class="upc">${esc(f.upc)}</span> isn't saved yet. Name it once and everyone at your store gets it.</p>
        <p class="lookup ${f.lookup || ""}" id="lookup-msg">${lookupText(f)}</p>
        <div class="field"><label for="np-name">Name</label><input id="np-name" placeholder="e.g. 2% Milk, Gallon" autocomplete="off" value="${esc(f.suggest?.name || "")}"></div>
        <div class="field"><label for="np-cat">Category</label><input id="np-cat" list="cats" value="${esc(f.suggest?.category || defCat)}" autocomplete="off"><datalist id="cats">${["Milk", "Yogurt", "Cheese", "Eggs", "Butter", "Cream", "Juice", ...cats].filter((v, i, a) => a.indexOf(v) === i).map((c) => `<option value="${esc(c)}">`).join("")}</datalist></div>
        <div class="field"><label for="np-days">Typical days until expiration when stocked</label><input id="np-days" type="number" inputmode="numeric" min="1" max="365" value="14"></div>
        <div class="row"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary grow" data-act="new-save">Save product</button></div>
      </div>`;
  }
  if (f.step === "form") {
    const p = productOf(f.upc);
    return `<h2>Log on shelf</h2>
      <div class="card">
        <div><div class="name">${esc(p.name)}</div><div class="upc">${esc(f.upc)} · ${esc(p.category || "")}</div></div>
        <div class="field"><label for="sf-exp">Expiration date on the package</label><input id="sf-exp" type="date" value="${addDays(today(), p.shelfDays || 14)}"></div>
        <div class="chips"><button class="chip" data-act="exp" data-n="-1">−1 day</button><button class="chip" data-act="exp" data-n="1">+1 day</button><button class="chip" data-act="exp" data-n="7">+1 week</button></div>
        <div class="field"><label for="sf-qty">Units put out</label><div class="stepper"><button class="btn" data-act="qty" data-n="-1" aria-label="One fewer">−</button><input id="sf-qty" type="number" inputmode="numeric" min="1" value="${p.lastQty || 6}"><button class="btn" data-act="qty" data-n="1" aria-label="One more">+</button></div></div>
        <div class="row"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary grow" data-act="stock-save">Log it</button></div>
      </div>`;
  }
  if (f.step === "rotate") {
    const p = productOf(f.upc);
    const older = S.batches.filter((b) => f.ids.includes(b.id) && isOpen(b)).sort((a, b) => (a.exp < b.exp ? -1 : 1));
    if (!older.length) { S.flow = { step: "scan" }; return stockView(); }
    return `<h2>Older dates still out?</h2>
      <p class="hint">You're already at the shelf. Glance at the front of ${esc(p.name)} so the tracker knows what sold.</p>
      <div class="list">${older.map((b) => `<article class="item soon"><div class="code">${dateCode(b.exp)}</div><div class="info"><div class="name">Is ${dateCode(b.exp)} still on the shelf?</div><div class="meta">${esc(whenText(daysLeft(b.exp)))} · ${b.qty || 0} stocked</div></div><div class="actions"><button class="btn" data-act="rot-out" data-id="${b.id}">Yes, still out</button><button class="btn primary" data-act="rot-gone" data-id="${b.id}">No, sold through</button></div></article>`).join("")}</div>
      <button class="btn big" data-act="cancel">Done</button>`;
  }
  return "";
}

/* ---------- Products ---------- */
function productsView() {
  if (!S.loaded) return notLoaded();
  if (S.imp) return importView();
  const ms = models(S.batches);
  const entries = Object.entries(S.products).sort((a, b) => (a[1].category || "").localeCompare(b[1].category || "") || a[1].name.localeCompare(b[1].name));
  let h = `<div class="prod-head"><h2>Products</h2>${canEditStore() ? `<button class="btn" data-act="imp-pick">Import item list</button>` : ""}</div>`;
  if (!entries.length) return h + `<div class="empty"><p><strong>No products yet.</strong></p><p class="hint">The first time anyone scans a UPC, they name it and it's saved here for the whole store.${canEditStore() ? " Or import your store's item list as a CSV or Excel file." : ""}</p></div>`;
  h += `<p class="hint">${entries.length} products</p>`;
  h += catChips() + `<div class="list">`;
  for (const [u, p] of entries) {
    if (!inCat(p)) continue;
    const m = ms[u] || emptyModel();
    const status = !m.learning ? `Sells about ${m.rate >= 10 ? Math.round(m.rate) : m.rate.toFixed(1)}/day` : `Learning: ${Math.min(m.restocks, 3)} of 3 restocks`;
    if (S.editUpc === u) {
      h += `<div class="card"><div class="upc">${esc(u)}</div>
        <div class="field"><label for="ep-name">Name</label><input id="ep-name" value="${esc(p.name)}"></div>
        <div class="field"><label for="ep-cat">Category</label><input id="ep-cat" value="${esc(p.category || "")}"></div>
        <div class="field"><label for="ep-days">Typical days until expiration</label><input id="ep-days" type="number" min="1" value="${p.shelfDays || 14}"></div>
        <div class="row"><button class="btn" data-act="edit-cancel">Cancel</button><button class="btn primary grow" data-act="edit-save" data-upc="${esc(u)}">Save</button></div>
        ${deleteBlock(u, p)}</div>`;
    } else {
      h += `<button class="prow" data-act="edit" data-upc="${esc(u)}"><span class="info"><span class="name">${esc(p.name)}</span><br><span class="upc">${esc(u)} · ${esc(p.category || "")}</span></span><span class="right">${esc(status)}<br>${p.shelfDays || 14}-day dates</span></button>`;
    }
  }
  return h + `</div>`;
}

function deleteBlock(u, p) {
  if (S.confirmDel !== u) return `<button class="linkbtn danger" data-act="del-ask" data-upc="${esc(u)}">Delete this product</button>`;
  const dates = S.batches.filter((b) => b.upc === u);
  const onShelf = dates.filter(isOpen).length;
  const what = dates.length
    ? `This also deletes its ${dates.length} logged date${dates.length === 1 ? "" : "s"}${onShelf ? `, including ${onShelf} still on the shelf` : ""}. They'll drop off the check list and results.`
    : "It has no logged dates.";
  return `<div class="confirm-box" role="alert">
      <p><strong>Delete ${esc(p.name)} for everyone at your store?</strong></p>
      <p class="hint">${what} This can't be undone. If it's scanned again later, it will be treated as a new product.</p>
      <div class="row"><button class="btn" data-act="del-cancel">Keep it</button><button class="btn pull grow" data-act="del-go" data-upc="${esc(u)}">Delete product</button></div>
    </div>`;
}

/* ---------- Import item list ---------- */
function importView() {
  const c = S.imp;
  const res = importer.build(c);
  const fresh = res.items.filter((p) => !S.products[p.upc]);
  const already = res.items.length - fresh.length;
  const colOpts = (sel, none) => (none ? `<option value="-1" ${sel < 0 ? "selected" : ""}>${none}</option>` : "") + c.headers.map((h, i) => `<option value="${i}" ${sel === i ? "selected" : ""}>${esc(h)}</option>`).join("");
  const example = c.body.find((r) => r[c.upcCol]) || [];
  let h = `<h2>Import item list</h2>
    <p class="hint">${esc(c.fileName)} · ${c.body.length} rows</p>
    <div class="card">
      <div class="field"><label for="imp-upc">Column with the UPC</label><select id="imp-upc">${colOpts(c.upcCol, "Pick a column")}</select></div>
      <div class="field"><label for="imp-name">Column with the item name</label><select id="imp-name">${colOpts(c.nameCol, "Pick a column")}</select></div>
      <div class="field"><label for="imp-size">Column with the size (optional)</label><select id="imp-size">${colOpts(c.sizeCol, "None")}</select></div>
      <div class="field"><label for="imp-catmode">Category</label><select id="imp-catmode">
        <option value="one" ${!c.useCategoryCol ? "selected" : ""}>Put everything in one category</option>
        ${c.headers.map((hd, i) => `<option value="${i}" ${c.useCategoryCol && c.categoryCol === i ? "selected" : ""}>Use column: ${esc(hd)}</option>`).join("")}</select></div>
      ${!c.useCategoryCol ? `<div class="field"><label for="imp-cat">Category name</label><input id="imp-cat" value="${esc(c.category)}" list="imp-cats"><datalist id="imp-cats">${["Milk", "Yogurt", "Cheese", "Eggs", "Butter", "Cream", "Juice", "Dairy"].map((v) => `<option value="${v}">`).join("")}</datalist></div>` : ""}
      <div class="field"><label for="imp-days">Typical days until expiration</label><input id="imp-days" type="number" min="1" max="365" value="${c.shelfDays}"></div>
      <label class="check"><input type="checkbox" id="imp-caps" ${c.fixCaps ? "checked" : ""}> Change ALL CAPS names to normal capitals</label>
      <div class="field"><label for="imp-check">Do the UPCs include the last check digit?</label><select id="imp-check">
        <option value="auto" ${c.checkMode === "auto" ? "selected" : ""}>Figure it out (looks like ${res.withCheck ? "yes" : "no"})</option>
        <option value="yes" ${c.checkMode === "yes" ? "selected" : ""}>Yes, they're full barcodes</option>
        <option value="no" ${c.checkMode === "no" ? "selected" : ""}>No, the last digit is missing</option></select>
        <p class="hint">If scanning an imported item says "New product," try switching this.${example[c.upcCol] ? ` Example from your file: <span class="upc">${esc(example[c.upcCol])}</span> becomes <span class="upc">${esc(importer.normalizeUpc(example[c.upcCol], res.withCheck) || "not a UPC")}</span>.` : ""}</p></div>
    </div>`;
  if (res.items.length) {
    h += `<section class="section"><h3>Preview</h3><div class="list">${res.items.slice(0, 6).map((p) => `<div class="prow"><span class="info"><span class="name">${esc(p.name)}</span><br><span class="upc">${esc(p.upc)}</span></span><span class="right">${esc(p.category)}${S.products[p.upc] ? "<br>Already saved" : ""}</span></div>`).join("")}</div></section>`;
  }
  const notes = [`<strong>${fresh.length}</strong> new products to add`];
  if (already) notes.push(`${already} already in the app (left as they are)`);
  if (res.skipped) notes.push(`${res.skipped} rows skipped (no UPC or name)`);
  if (res.dupes) notes.push(`${res.dupes} repeated UPCs skipped`);
  h += `<div class="card"><p>${notes.join("<br>")}</p>
      <div class="row"><button class="btn" data-act="imp-cancel">Cancel</button><button class="btn primary grow" data-act="imp-go" ${fresh.length && !S.impBusy ? "" : "disabled"}>${S.impBusy ? "Importing…" : `Import ${fresh.length} products`}</button></div></div>`;
  return h;
}
async function pickImportFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,.txt,.tsv,.xlsx,.xls,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const rows = await importer.readFile(file);
      if (rows.length < 1) return toast("That file looks empty.");
      S.imp = { ...importer.setup(rows), fileName: file.name };
      S.fresh = true; render(); window.scrollTo(0, 0);
    } catch (e) { toast((e && e.message) || "Couldn't read that file. Try saving it as CSV."); }
  };
  input.click();
}
function updateImport(id, el) {
  const c = S.imp; if (!c) return;
  const n = parseInt(el.value, 10);
  if (id === "imp-upc") c.upcCol = n;
  else if (id === "imp-name") c.nameCol = n;
  else if (id === "imp-size") c.sizeCol = n;
  else if (id === "imp-catmode") { c.useCategoryCol = el.value !== "one"; if (c.useCategoryCol) c.categoryCol = n; }
  else if (id === "imp-cat") c.category = el.value.trim() || "Uncategorized";
  else if (id === "imp-days") c.shelfDays = Math.max(1, Math.min(365, n || 14));
  else if (id === "imp-caps") c.fixCaps = el.checked;
  else if (id === "imp-check") c.checkMode = el.value;
  else return;
  S.fresh = true; render();
}
document.addEventListener("change", (e) => { if (e.target.id && e.target.id.startsWith("imp-")) updateImport(e.target.id, e.target); });
async function runImport() {
  const res = importer.build(S.imp);
  const fresh = res.items.filter((p) => !S.products[p.upc]);
  if (!fresh.length) return;
  S.impBusy = true; render();
  try {
    await S.backend.importProducts(S.store, fresh, (done) => { if (fresh.length > 500) toast(`Saved ${done} of ${fresh.length}…`); });
    S.imp = null; toast(`Imported ${fresh.length} products`);
    await refresh();
  } catch (e) { toast((e && e.message) || "The import stopped partway. Run it again; saved products are skipped."); }
  finally { S.impBusy = false; S.fresh = true; render(); }
}

/* ---------- Results ---------- */
function resultsView() {
  if (!S.loaded) return notLoaded();
  const bs = S.batches;
  const rows = analysis().rows;
  const start = bs.length ? Math.min(...bs.map((b) => b.createdAt || Date.now())) : null;
  const restocks = bs.reduce((s, b) => s + (b.events || []).length, 0);
  const marked = bs.filter((b) => b.markedAt).length;
  const pulled = bs.filter((b) => b.status === "pulled").length;
  const wasted = bs.filter((b) => b.status === "gone" && b.closedVia === "check" && !b.markedAt).length;
  const atStock = bs.filter((b) => b.status === "gone" && b.closedVia === "stocking").length;
  const likelyNow = rows.filter((r) => r.likely).length;
  const useful = marked + pulled, checks = useful + wasted;
  const days = start ? Math.max(1, Math.ceil((Date.now() - start) / DAY)) : 0;
  let h = `<h2>Results</h2><p class="hint">${start ? `Tracking since ${shortDate(start)} · day ${days}` : "Starts when someone logs the first item."}</p>
    <div class="stats">
      <div class="stat"><div class="v">${Object.keys(S.products).length}</div><div class="l">Products tracked</div></div>
      <div class="stat"><div class="v">${restocks}</div><div class="l">Restocks logged</div></div>
      <div class="stat"><div class="v">${marked}</div><div class="l">Marked down before the date</div></div>
      <div class="stat"><div class="v">${pulled}</div><div class="l">Taken off on time</div></div>
    </div>
    <section class="section"><h3>Were the alerts worth walking over?</h3><div class="card">`;
  if (checks) h += `<div class="bar" role="img" aria-label="${useful} useful checks, ${wasted} already sold"><span style="width:${(useful / checks) * 100}%;background:var(--ok)"></span><span style="width:${(wasted / checks) * 100}%;background:var(--pull)"></span></div>
      <p><strong>${Math.round((useful / checks) * 100)}%</strong> of checks found product to mark down or take off. ${wasted} found it already sold.</p>`;
  else h += `<p class="hint">Shows once people act on alerts from the Check tab.</p>`;
  h += `</div></section>
    <section class="section"><h3>Cleared without a check</h3><div class="stats">
      <div class="stat"><div class="v">${atStock}</div><div class="l">Cleared while restocking</div></div>
      <div class="stat"><div class="v">${likelyNow}</div><div class="l">Predicted sold through right now</div></div></div></section>
    <section class="section"><h3>How it works</h3><div class="card"><p class="hint">Each restock tells the tracker how fast an item sells. After 3 restocks over 2 or more days, it estimates which dates are still on the shelf and only alerts on those. Fast sellers stop showing up; slow sellers get flagged before their date.</p></div></section>`;
  return h;
}

/* ---------- Store ---------- */
function storeView() {
  const st = S.store, own = canEditStore(), dis = own ? "" : "disabled";
  const hours = Array.from({ length: 24 }, (_, i) => `<option value="${i}" ${st.notifyHour === i ? "selected" : ""}>${new Date(2000, 0, 1, i).toLocaleTimeString([], { hour: "numeric" })}</option>`).join("");
  const phoneTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const alertsText = { on: "On for this phone", off: "Off for this phone", blocked: "Blocked in this phone's settings", unsupported: "Not available in this browser", unconfigured: "Not set up yet", unknown: "Checking…" }[S.alerts];
  let h = `<h2>${esc(st.name)}</h2>`;
  if (S.backend.kind !== "demo") h += `<div class="card"><div class="prod-head"><div><div class="l-label">Store code</div><div class="big-code">${esc(st.joinCode)}</div></div><button class="btn" data-act="copy-code">Copy</button></div><p class="hint">Coworkers enter this code after creating an account to join your store.</p></div>`;
  h += `<section class="section"><h3>Daily alert</h3><div class="card">
      <p><strong>${esc(alertsText)}</strong></p>
      ${S.alerts === "on" ? `<button class="btn" data-act="alerts-off">Turn off on this phone</button>` : S.alerts === "off" ? `<button class="btn primary" data-act="alerts-on">Turn on alerts</button>` : ""}
      ${S.alerts === "unsupported" ? `<p class="hint">On iPhone: tap Share, then Add to Home Screen, then open the app from your home screen and try again.</p>` : ""}
      ${S.alerts === "blocked" ? `<p class="hint">Allow notifications for this app in your phone's settings, then come back.</p>` : ""}
      <div class="field"><label for="st-hour">Send it at</label><select id="st-hour" ${dis}>${hours}</select></div>
      <p class="hint">Time zone: ${esc(st.timezone)}${own && phoneTz !== st.timezone ? ` · <button class="linkbtn inline" data-act="use-tz" data-tz="${esc(phoneTz)}">Use ${esc(phoneTz)}</button>` : ""}</p>
    </div></section>
    <section class="section"><h3>Alert timing</h3><div class="card">
      <div class="field"><label for="st-md">Mark down when this many days are left</label><input id="st-md" type="number" min="0" max="14" value="${st.markdownDays}" ${dis}></div>
      <div class="field"><label for="st-pull">Pull</label><select id="st-pull" ${dis}>
        <option value="1" ${st.pullDays === 1 ? "selected" : ""}>The day before the date</option>
        <option value="0" ${st.pullDays === 0 ? "selected" : ""}>On the date</option>
        <option value="-1" ${st.pullDays === -1 ? "selected" : ""}>The day after the date</option></select></div>
      ${own ? `<button class="btn primary" data-act="store-save">Save settings</button>` : `<p class="hint">Only the person who started this store can change these.</p>`}
    </div></section>`;
  if (S.backend.kind === "demo") {
    h += `<section class="section"><h3>Demo</h3><div class="card">
      <button class="btn" data-act="demo-sample">Load example milk week</button>
      <button class="btn" data-act="demo-clear">Clear demo data</button>
      ${configured ? `<button class="btn" data-act="demo-leave">Leave demo mode</button>` : ""}</div></section>`;
  } else {
    h += `<section class="section"><h3>Account</h3><div class="card">
      ${S.stores.length > 1 ? `<div class="field"><label for="st-switch">Switch store</label><select id="st-switch">${S.stores.map((s) => `<option value="${s.id}" ${s.id === st.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div><button class="btn" data-act="switch">Switch</button>` : ""}
      <button class="btn" data-act="add-store">Join or start another store</button>
      <button class="btn" data-act="signout">Sign out</button></div></section>`;
  }
  return h;
}

/* ================= actions ================= */
function startUpc(raw) {
  const upc = normUpc(raw);
  if (upc.length < 6) { toast("That doesn't look like a UPC. Check the number."); return; }
  S.flow = { step: S.products[upc] ? "form" : "new", upc };
  if (S.flow.step === "new") S.flow.lookup = "loading";
  S.fresh = true; render();
  if (S.flow.step === "new") fillFromLookup(S.flow);
}

/* ---------- product lookup (Open Food Facts, a free public grocery database) ---------- */
function lookupText(f) {
  if (f.lookup === "loading") return "Looking up this barcode…";
  if (f.lookup === "found") return "Name found in a public product database. Check it and fix anything that's off.";
  if (f.lookup === "none") return "Not found in the public product database. Type the name below.";
  return "";
}
const CATEGORY_TAGS = [
  ["Milk", ["en:milks", "en:plant-based-milks", "en:flavoured-milks", "en:dairy-drinks", "en:milk-substitutes"]],
  ["Yogurt", ["en:yogurts", "en:fermented-milk-products", "en:kefir"]],
  ["Cheese", ["en:cheeses"]],
  ["Eggs", ["en:eggs", "en:chicken-eggs"]],
  ["Butter", ["en:butters", "en:margarines"]],
  ["Cream", ["en:creams", "en:sour-creams", "en:coffee-creamers", "en:creamers", "en:whipped-creams"]],
  ["Juice", ["en:juices", "en:fruit-juices", "en:orange-juices"]],
];
function guessCategory(tags) {
  for (const [cat, list] of CATEGORY_TAGS) if (tags.some((t) => list.includes(t))) return cat;
  return null;
}
async function lookupUpc(upc) {
  const codes = upc.length === 12 ? [upc, "0" + upc] : [upc];
  for (const c of codes) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${c}.json?fields=product_name,product_name_en,brands,quantity,categories_tags`, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      const p = j && j.status === 1 && j.product;
      if (!p) continue;
      const title = (p.product_name_en || p.product_name || "").trim();
      const brand = (p.brands || "").split(",")[0].trim();
      const qty = (p.quantity || "").replace(/\s+e$/, "").trim();
      const parts = [];
      if (brand && !title.toLowerCase().includes(brand.toLowerCase())) parts.push(brand);
      if (title) parts.push(title);
      if (qty && !title.toLowerCase().includes(qty.toLowerCase())) parts.push(qty);
      const name = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
      if (name) return { name, category: guessCategory(p.categories_tags || []) };
    } catch (e) { /* offline or slow: fall through */ }
  }
  return null;
}
async function fillFromLookup(f) {
  const hit = await lookupUpc(f.upc);
  if (S.flow !== f || f.step !== "new") return; // user moved on
  f.lookup = hit ? "found" : "none";
  if (hit) f.suggest = hit;
  const msg = $("#lookup-msg");
  if (msg) { msg.textContent = lookupText(f); msg.className = "lookup " + f.lookup; }
  const nameEl = $("#np-name"), catEl = $("#np-cat");
  if (hit && nameEl && !nameEl.value.trim()) nameEl.value = hit.name;
  if (hit && hit.category && catEl && !catEl.dataset.touched) catEl.value = hit.category;
  if (nameEl && !hit) nameEl.focus();
}
document.addEventListener("input", (e) => { if (e.target.id === "np-cat") e.target.dataset.touched = "1"; });
async function saveNew() {
  const name = $("#np-name").value.trim();
  if (!name) return toast("Give the product a name.");
  const p = { name, category: $("#np-cat").value.trim() || "Uncategorized", shelfDays: Math.max(1, parseInt($("#np-days").value, 10) || 14) };
  const upc = S.flow.upc;
  if (await act(() => S.backend.addProduct(S.store, upc, p), "Product saved")) {
    S.products[upc] = { ...S.products[upc], ...p };
    S.flow = { step: "form", upc }; S.fresh = true; render();
  }
}
async function saveStock() {
  const upc = S.flow.upc, exp = $("#sf-exp").value, qty = parseInt($("#sf-qty").value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return toast("Pick the expiration date.");
  if (!(qty > 0)) return toast("Enter how many units you put out.");
  const now = Date.now();
  const existing = S.batches.find((b) => b.upc === upc && b.exp === exp && isOpen(b));
  const ok = await act(async () => {
    if (existing) await S.backend.updateBatch(S.store, existing.id, { qty: (existing.qty || 0) + qty, events: [...(existing.events || []), { at: now, qty }] });
    else await S.backend.addBatch(S.store, { upc, exp, qty, events: [{ at: now, qty }] });
    const patch = { lastQty: qty, lastStockedAt: now };
    const sd = daysBetween(today(), exp);
    if (sd > 0) patch.shelfDays = sd;
    await S.backend.updateProduct(S.store, upc, patch);
  }, `Logged ${qty} × ${dateCode(exp)}`);
  if (!ok) return;
  const older = S.batches.filter((b) => b.upc === upc && isOpen(b) && b.exp < exp).map((b) => b.id);
  S.flow = older.length ? { step: "rotate", upc, ids: older } : { step: "scan" };
  S.fresh = true; render();
}
function closeBatch(id, outcome, alert, via) {
  const b = S.batches.find((x) => x.id === id); if (!b) return;
  const m = models(S.batches)[b.upc] || emptyModel();
  const predicted = m.learning ? "learning" : m.likelySold.has(id) ? "sold" : "present";
  return act(() => S.backend.updateBatch(S.store, id, { status: outcome, closedAt: Date.now(), closedVia: via || "check", alert: alert || null, predicted }), outcome === "pulled" ? "Marked as taken off" : "Marked as sold");
}

/* ---------- push alerts ---------- */
function b64ToBytes(s) { const p = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
async function checkAlerts() {
  if (S.backend.kind === "demo" || !VAPID_PUBLIC_KEY) S.alerts = "unconfigured";
  else if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) S.alerts = "unsupported";
  else if (Notification.permission === "denied") S.alerts = "blocked";
  else {
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); S.alerts = sub && Notification.permission === "granted" ? "on" : "off"; }
    catch (e) { S.alerts = "off"; }
  }
  if (S.tab === "store") render();
}
async function alertsOn() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { S.alerts = perm === "denied" ? "blocked" : "off"; render(); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
    await S.backend.saveSubscription(S.store, sub);
    S.alerts = "on"; toast("Alerts are on for this phone"); render();
  } catch (e) { toast((e && e.message) || "Alerts couldn't be turned on."); }
}
async function alertsOff() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await S.backend.removeSubscription(sub.endpoint); await sub.unsubscribe(); }
    S.alerts = "off"; toast("Alerts are off for this phone"); render();
  } catch (e) { toast((e && e.message) || "Couldn't turn alerts off."); }
}

/* ---------- events ---------- */
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "auth-form") return;
  e.preventDefault();
  const email = $("#au-email").value.trim(), pass = $("#au-pass").value;
  const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
  try {
    if (S.authMode === "signup") {
      const r = await S.backend.signUp(email, pass);
      if (r.needsConfirm) { toast("Check your email and tap the confirmation link, then sign in."); S.authMode = "signin"; S.fresh = true; render(); }
    } else await S.backend.signIn(email, pass);
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; }
});

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]"); if (!el || el.disabled) return;
  const a = el.dataset.act, id = el.dataset.id;
  switch (a) {
    case "tab": return go(el.dataset.tab);
    case "reload": return location.reload();
    case "demo": return startDemo();
    case "auth-mode": S.authMode = S.authMode === "signup" ? "signin" : "signup"; S.fresh = true; return render();
    case "join": {
      const code = $("#js-code").value.trim(); if (!code) return toast("Enter the store code.");
      try { S.store = await S.backend.joinStore(code); S.stores = await S.backend.myStores(); enterStore(); } catch (err) { toast(err.message); }
      return;
    }
    case "create-store": {
      const name = $("#cs-name").value.trim(); if (!name) return toast("Name the store or department.");
      try { S.store = await S.backend.createStore(name); S.stores = await S.backend.myStores(); await S.backend.updateStore(S.store, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); enterStore(); } catch (err) { toast(err.message); }
      return;
    }
    case "signout": await S.backend.signOut(); S.store = null; S.loaded = false; store.set("sdt-store", null); return;
    case "cat": S.cat = el.dataset.cat; return render();
    case "likely": S.showLikely = !S.showLikely; return render();
    case "scan": { const code = await scanBarcode(); if (code) startUpc(code); return; }
    case "upc-go": return startUpc($("#upc").value);
    case "pick": return startUpc(el.dataset.upc);
    case "cancel": S.flow = { step: "scan" }; S.fresh = true; return render();
    case "new-save": return saveNew();
    case "stock-save": return saveStock();
    case "exp": { const i = $("#sf-exp"); if (i.value) i.value = addDays(i.value, Number(el.dataset.n)); return; }
    case "qty": { const i = $("#sf-qty"); i.value = Math.max(1, (parseInt(i.value, 10) || 0) + Number(el.dataset.n)); return; }
    case "close": return closeBatch(id, el.dataset.outcome, el.dataset.alert, el.dataset.via);
    case "mark": return act(() => S.backend.updateBatch(S.store, id, { status: "marked", markedAt: Date.now() }), "Marked down");
    case "seen": return act(() => S.backend.updateBatch(S.store, id, { seenAt: Date.now() }), "Back on the check list");
    case "pass": return act(() => S.backend.updateBatch(S.store, id, { passedOn: today(), seenAt: Date.now() }), "Passed for today");
    case "unpass": return act(() => S.backend.updateBatch(S.store, id, { passedOn: null }), "Back on the check list");
    case "rot-out": S.flow.ids = S.flow.ids.filter((x) => x !== id); return act(() => S.backend.updateBatch(S.store, id, { seenAt: Date.now() }));
    case "rot-gone": S.flow.ids = S.flow.ids.filter((x) => x !== id); return act(() => S.backend.updateBatch(S.store, id, { status: "gone", closedAt: Date.now(), closedVia: "stocking" }));
    case "edit": S.editUpc = el.dataset.upc; S.confirmDel = null; S.fresh = true; return render();
    case "edit-cancel": S.editUpc = null; S.confirmDel = null; S.fresh = true; return render();
    case "del-ask": S.confirmDel = el.dataset.upc; return render();
    case "del-cancel": S.confirmDel = null; return render();
    case "del-go": {
      const upc = el.dataset.upc, name = productOf(upc).name;
      el.disabled = true;
      if (await act(() => S.backend.deleteProduct(S.store, upc), `Deleted ${name}`)) { S.editUpc = null; S.confirmDel = null; S.fresh = true; render(); }
      else el.disabled = false;
      return;
    }
    case "edit-save": {
      const name = $("#ep-name").value.trim(); if (!name) return toast("Give the product a name.");
      if (await act(() => S.backend.updateProduct(S.store, el.dataset.upc, { name, category: $("#ep-cat").value.trim() || "Uncategorized", shelfDays: Math.max(1, parseInt($("#ep-days").value, 10) || 14) }), "Product updated")) { S.editUpc = null; S.fresh = true; render(); }
      return;
    }
    case "store-save": {
      const p = { markdownDays: Math.max(0, Math.min(14, parseInt($("#st-md").value, 10) || 0)), pullDays: parseInt($("#st-pull").value, 10), notifyHour: parseInt($("#st-hour").value, 10) };
      return act(() => S.backend.updateStore(S.store, p), "Settings saved");
    }
    case "use-tz": return act(() => S.backend.updateStore(S.store, { timezone: el.dataset.tz }), "Time zone updated");
    case "copy-code": try { await navigator.clipboard.writeText(S.store.joinCode); toast("Store code copied"); } catch (err) { toast("Code: " + S.store.joinCode); } return;
    case "alerts-on": return alertsOn();
    case "alerts-off": return alertsOff();
    case "switch": { const sid = $("#st-switch").value; S.store = S.stores.find((s) => s.id === sid); S.loaded = false; return enterStore(); }
    case "add-store": S.screen = "pickStore"; S.fresh = true; return render();
    case "back-app": S.screen = "app"; S.fresh = true; return render();
    case "imp-pick": return pickImportFile();
    case "imp-cancel": S.imp = null; S.fresh = true; return render();
    case "imp-go": return runImport();
    case "demo-sample": S.backend.loadSample(); return toast("Example week loaded. Items marked (example) aren't real.");
    case "demo-clear": S.backend.reset(); await refresh(); return toast("Demo data cleared");
    case "demo-leave": store.set("sdt-mode", null); return location.reload();
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "upc") { e.preventDefault(); startUpc(e.target.value); } });

boot();
