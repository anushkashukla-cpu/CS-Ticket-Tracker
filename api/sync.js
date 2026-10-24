// Daily safety net: re-checks recent chats that are still untagged and copies any
// Category/Subcategory agents have since added in Freshchat. Runs on the Vercel cron in vercel.json,
// or manually:  curl -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/sync?days=7
import { json, fsUntagged, refreshTags, missingEnv } from "./_lib.js";

export async function GET(request) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret || request.headers.get("authorization") !== "Bearer " + secret) return json({ ok: false, error: "unauthorized" }, 401);
  const missing = missingEnv();
  if (missing.length) return json({ ok: false, error: "Missing environment variables: " + missing.join(", ") }, 500);

  const url = new URL(request.url);
  const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 7));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const started = Date.now();

  const todo = (await fsUntagged(1000)).filter((t) => t.convId && !t.tagManual && (t.createdAt || "") >= since);
  let checked = 0, updated = 0, errors = 0, i = 0;
  async function worker() {
    while (i < todo.length && Date.now() - started < 240000) {
      const t = todo[i++];
      try { if (await refreshTags(t)) updated++; } catch (e) { errors++; console.error(t.id, e.message); }
      checked++;
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return json({ ok: true, days, untagged: todo.length, checked, updated, errors, unfinished: todo.length - checked });
}
