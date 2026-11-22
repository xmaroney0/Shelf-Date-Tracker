// Sends the daily "what to check" alert to every phone that turned alerts on.
// GitHub runs this every hour (see .github/workflows/daily-alerts.yml). For each store,
// it only sends when it's that store's chosen hour, and at most once per day per phone.
//
// Needs these GitHub secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@example.com)
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";
import { analyze, needsAction } from "../model.js";

const env = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing secret ${k}`); process.exit(1); } return v; };
const force = process.env.FORCE === "true"; // "Run workflow" button: send now regardless of hour

webpush.setVapidDetails(env("VAPID_SUBJECT"), env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const must = ({ data, error }) => { if (error) throw error; return data; };

function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const stores = must(await sb.from("stores").select("*"));
let sent = 0;
for (const st of stores) {
  const { date, hour } = localNow(st.timezone || "America/New_York");
  if (!force && hour !== st.notify_hour) continue;

  const subs = must(await sb.from("push_subscriptions").select("*").eq("store_id", st.id)).filter((s) => force || s.last_sent_on !== date);
  if (!subs.length) continue;

  const products = {};
  must(await sb.from("products").select("*").eq("store_id", st.id)).forEach((p) => (products[p.upc] = { name: p.name, category: p.category }));
  const batches = must(await sb.from("batches").select("*").eq("store_id", st.id).limit(5000)).map((b) => ({
    id: b.id, upc: b.upc, exp: b.exp, qty: b.qty, events: b.events || [], status: b.status,
    seenAt: b.seen_at ? new Date(b.seen_at).getTime() : null,
  }));
  const rows = analyze({ batches, products, settings: { markdownDays: st.markdown_days, pullDays: st.pull_days }, today: date }).rows.filter(needsAction);
  const pull = rows.filter((r) => r.level === "pull"), mark = rows.filter((r) => r.level === "markdown");
  if (!rows.length) { console.log(`${st.name}: nothing to check`); continue; }

  const parts = [];
  if (pull.length) parts.push(`${pull.length} to pull`);
  if (mark.length) parts.push(`${mark.length} to mark down`);
  const names = rows.slice(0, 3).map((r) => r.p.name).join(", ") + (rows.length > 3 ? ` and ${rows.length - 3} more` : "");
  const payload = JSON.stringify({ title: `${st.name}: ${parts.join(", ")}`, body: names, url: "./" });

  for (const s of subs) {
    try {
      await webpush.sendNotification(s.subscription, payload, { TTL: 6 * 3600 });
      await sb.from("push_subscriptions").update({ last_sent_on: date }).eq("endpoint", s.endpoint);
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint); // phone turned alerts off
      else console.error(`Send failed (${e.statusCode || e.message})`);
    }
  }
  console.log(`${st.name}: ${parts.join(", ")} -> ${subs.length} phone(s)`);
}
console.log(`Done. ${sent} alert(s) sent.`);
