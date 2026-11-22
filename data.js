// Data layer. Two backends with the same methods:
//  - Supabase: the real shared database (after setup)
//  - Demo: saved only on this phone, for trying the app before setup
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const ms = (t) => (t ? new Date(t).getTime() : null);
const iso = (n) => (n ? new Date(n).toISOString() : null);

const toBatch = (r) => ({
  id: r.id, upc: r.upc, exp: r.exp, qty: r.qty, events: r.events || [], status: r.status,
  markedAt: ms(r.marked_at), seenAt: ms(r.seen_at), closedAt: ms(r.closed_at), closedVia: r.closed_via,
  alert: r.alert, predicted: r.predicted, createdAt: ms(r.created_at), passedOn: r.passed_on || null,
});
const BATCH_COLS = { qty: "qty", events: "events", status: "status", markedAt: "marked_at", seenAt: "seen_at", closedAt: "closed_at", closedVia: "closed_via", alert: "alert", predicted: "predicted", passedOn: "passed_on" };
const batchPatch = (p) => {
  const o = {};
  for (const k in p) { const c = BATCH_COLS[k]; if (!c) continue; o[c] = c.endsWith("_at") ? iso(p[k]) : p[k]; }
  return o;
};
const toProduct = (r) => ({ name: r.name, category: r.category, shelfDays: r.shelf_days, lastQty: r.last_qty, lastStockedAt: ms(r.last_stocked_at) });
const PROD_COLS = { name: "name", category: "category", shelfDays: "shelf_days", lastQty: "last_qty", lastStockedAt: "last_stocked_at" };
const prodPatch = (p) => { const o = {}; for (const k in p) { const c = PROD_COLS[k]; if (c) o[c] = c.endsWith("_at") ? iso(p[k]) : p[k]; } return o; };
const toStore = (r) => ({ id: r.id, name: r.name, joinCode: r.join_code, markdownDays: r.markdown_days, pullDays: r.pull_days, timezone: r.timezone, notifyHour: r.notify_hour, role: r.role });
const STORE_COLS = { name: "name", markdownDays: "markdown_days", pullDays: "pull_days", timezone: "timezone", notifyHour: "notify_hour" };
const storePatch = (p) => { const o = {}; for (const k in p) if (STORE_COLS[k]) o[STORE_COLS[k]] = p[k]; return o; };

function friendly(error) {
  const msg = (error && error.message) || String(error);
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "No connection. Check your signal and try again.";
  if (/Invalid login credentials/i.test(msg)) return "That email and password don't match.";
  if (/Email not confirmed/i.test(msg)) return "Confirm your email first: open the link we emailed you.";
  if (/already registered/i.test(msg)) return "That email already has an account. Sign in instead.";
  if (/Password should be/i.test(msg)) return "Use a password with at least 6 characters.";
  return msg;
}
const check = ({ data, error }) => { if (error) throw new Error(friendly(error)); return data; };

/* ---------------- Supabase ---------------- */
export async function supabaseBackend() {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  let channel = null;

  return {
    kind: "supabase",
    client: sb,
    async session() { const { data } = await sb.auth.getSession(); return data.session; },
    onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => cb(s)); },
    async signIn(email, password) { check(await sb.auth.signInWithPassword({ email, password })); },
    async signUp(email, password) {
      const data = check(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }));
      return { needsConfirm: !data.session };
    },
    async signOut() { if (channel) sb.removeChannel(channel); channel = null; await sb.auth.signOut(); },
    async myStores() {
      const { data: { user } } = await sb.auth.getUser();
      const rows = check(await sb.from("members").select("role, stores(*)").eq("user_id", user.id));
      return rows.filter((r) => r.stores).map((r) => toStore({ ...r.stores, role: r.role }));
    },
    async createStore(name) { return toStore({ ...check(await sb.rpc("create_store", { p_name: name })), role: "owner" }); },
    async joinStore(code) { return toStore({ ...check(await sb.rpc("join_store", { p_code: code })), role: "member" }); },
    async load(store) {
      const [prods, bats, st] = await Promise.all([
        sb.from("products").select("*").eq("store_id", store.id),
        sb.from("batches").select("*").eq("store_id", store.id).limit(5000),
        sb.from("stores").select("*").eq("id", store.id).single(),
      ]);
      const products = {};
      check(prods).forEach((r) => (products[r.upc] = toProduct(r)));
      return { products, batches: check(bats).map(toBatch), store: { ...toStore(check(st)), role: store.role } };
    },
    watch(store, onChange) {
      if (channel) sb.removeChannel(channel);
      let t = null;
      const ping = () => { clearTimeout(t); t = setTimeout(onChange, 300); };
      channel = sb.channel("store-" + store.id)
        .on("postgres_changes", { event: "*", schema: "public", table: "batches", filter: "store_id=eq." + store.id }, ping)
        .on("postgres_changes", { event: "*", schema: "public", table: "products", filter: "store_id=eq." + store.id }, ping)
        .on("postgres_changes", { event: "*", schema: "public", table: "stores", filter: "id=eq." + store.id }, ping)
        .subscribe();
    },
    async addProduct(store, upc, p) {
      check(await sb.from("products").insert({ store_id: store.id, upc, ...prodPatch(p) }));
    },
    async updateProduct(store, upc, p) { check(await sb.from("products").update(prodPatch(p)).eq("store_id", store.id).eq("upc", upc)); },
    // Deleting a product also deletes its logged dates (the database cascades it).
    async deleteProduct(store, upc) { check(await sb.from("products").delete().eq("store_id", store.id).eq("upc", upc)); },
    // Adds many products at once. Products already saved are left as they are.
    async importProducts(store, list, onProgress) {
      for (let i = 0; i < list.length; i += 500) {
        const rows = list.slice(i, i + 500).map((p) => ({ store_id: store.id, upc: p.upc, ...prodPatch(p) }));
        check(await sb.from("products").upsert(rows, { onConflict: "store_id,upc", ignoreDuplicates: true }));
        if (onProgress) onProgress(Math.min(i + 500, list.length));
      }
    },
    async addBatch(store, b) {
      check(await sb.from("batches").insert({ store_id: store.id, upc: b.upc, exp: b.exp, qty: b.qty, events: b.events, status: "open" }));
    },
    async updateBatch(store, id, p) { check(await sb.from("batches").update(batchPatch(p)).eq("id", id)); },
    async updateStore(store, p) { check(await sb.from("stores").update(storePatch(p)).eq("id", store.id)); },
    async saveSubscription(store, sub) {
      check(await sb.from("push_subscriptions").upsert({ endpoint: sub.endpoint, store_id: store.id, subscription: sub.toJSON ? sub.toJSON() : sub }, { onConflict: "endpoint" }));
    },
    async removeSubscription(endpoint) { check(await sb.from("push_subscriptions").delete().eq("endpoint", endpoint)); },
  };
}

/* ---------------- Demo (this phone only) ---------------- */
const KEY = "sdt-demo-v1";
function readDemo() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); if (v) return v; } catch (e) {}
  return { store: { id: "demo", name: "Demo store", joinCode: "DEMO00", markdownDays: 2, pullDays: 0, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, notifyHour: 6, role: "owner" }, products: {}, batches: [] };
}
function writeDemo(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { throw new Error("This phone won't let the app save. Turn off private browsing."); } }

export function demoBackend() {
  let listener = null;
  const mutate = (fn) => { const v = readDemo(); fn(v); writeDemo(v); setTimeout(() => listener && listener(), 0); };
  return {
    kind: "demo",
    async session() { return { user: { email: "demo" } }; },
    onAuth() {},
    async signOut() {},
    async myStores() { return [readDemo().store]; },
    async load() { const v = readDemo(); return { products: v.products, batches: v.batches, store: v.store }; },
    watch(_s, cb) { listener = cb; },
    async addProduct(_s, upc, p) { mutate((v) => (v.products[upc] = { ...p })); },
    async updateProduct(_s, upc, p) { mutate((v) => (v.products[upc] = { ...v.products[upc], ...p })); },
    async deleteProduct(_s, upc) { mutate((v) => { delete v.products[upc]; v.batches = v.batches.filter((b) => b.upc !== upc); }); },
    async importProducts(_s, list, onProgress) {
      mutate((v) => list.forEach((p) => { if (!v.products[p.upc]) { const { upc, ...rest } = p; v.products[upc] = rest; } }));
      if (onProgress) onProgress(list.length);
    },
    async addBatch(_s, b) { mutate((v) => v.batches.push({ id: "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), status: "open", createdAt: Date.now(), ...b })); },
    async updateBatch(_s, id, p) { mutate((v) => { const b = v.batches.find((x) => x.id === id); if (b) Object.assign(b, p); }); },
    async updateStore(_s, p) { mutate((v) => Object.assign(v.store, p)); },
    reset() { try { localStorage.removeItem(KEY); } catch (e) {} },
    // Fills in a realistic week of milk so you can see predictions working.
    loadSample() {
      const now = Date.now(), D = 864e5;
      const day = (n) => { const d = new Date(now + n * D); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
      const v = readDemo();
      v.products = {
        "070000000011": { name: "Whole Milk, Gallon (example)", category: "Milk", shelfDays: 14, lastQty: 24 },
        "070000000028": { name: "2% Milk, Gallon (example)", category: "Milk", shelfDays: 14, lastQty: 24 },
        "070000000035": { name: "Oat Milk, Half Gallon (example)", category: "Milk", shelfDays: 30, lastQty: 6 },
        "070000000042": { name: "Lactose Free 2%, Half Gallon (example)", category: "Milk", shelfDays: 21, lastQty: 6 },
        "070000000059": { name: "Plain Kefir, Quart (example)", category: "Yogurt", shelfDays: 18, lastQty: 4 },
      };
      const ev = (...pairs) => pairs.map(([d, q]) => ({ at: now + d * D, qty: q }));
      v.batches = [
        // Fast seller: restocked daily, old date should be predicted sold through
        { id: "s1", upc: "070000000011", exp: day(1), qty: 24, events: ev([-6, 24]), status: "open", createdAt: now - 6 * D },
        { id: "s2", upc: "070000000011", exp: day(5), qty: 48, events: ev([-4, 24], [-3, 24]), status: "open", createdAt: now - 4 * D },
        { id: "s3", upc: "070000000011", exp: day(9), qty: 48, events: ev([-2, 24], [-1, 24]), status: "open", createdAt: now - 2 * D },
        { id: "s4", upc: "070000000028", exp: day(2), qty: 24, events: ev([-5, 24]), status: "open", createdAt: now - 5 * D },
        { id: "s5", upc: "070000000028", exp: day(8), qty: 24, events: ev([-1, 24]), status: "open", createdAt: now - 1 * D },
        // Slow sellers: should alert
        { id: "s6", upc: "070000000035", exp: day(0), qty: 6, events: ev([-12, 6]), status: "open", createdAt: now - 12 * D },
        { id: "s7", upc: "070000000035", exp: day(20), qty: 6, events: ev([-3, 6]), status: "open", createdAt: now - 3 * D },
        { id: "s8", upc: "070000000042", exp: day(2), qty: 6, events: ev([-10, 6]), status: "open", createdAt: now - 10 * D },
        { id: "s9", upc: "070000000059", exp: day(4), qty: 4, events: ev([-9, 4]), status: "open", createdAt: now - 9 * D },
      ];
      writeDemo(v);
      setTimeout(() => listener && listener(), 0);
    },
  };
}
