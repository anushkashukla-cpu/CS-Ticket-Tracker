// Used by the tracker's import: for chats in a file that aren't in the tracker yet (or have no date),
// look each one up in Freshchat and add it with its real date, link, channel, customer messages and tags.
// Protected by the tracker access key (the same key in the tracker link).
import { CFG, json, missingEnv, enrichConversation, loadRouter } from "./_lib.js";

const MAX_ITEMS = 80;

export async function POST(request) {
  const missing = missingEnv();
  if (missing.length) return json({ ok: false, error: "Missing environment variables: " + missing.join(", ") }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }
  if (!body || body.key !== CFG.trackerKey) return json({ ok: false, error: "wrong access key" }, 401);
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((x) => x && typeof x.convId === "string" && /^[A-Za-z0-9_\-:.]{6,120}$/.test(x.convId)).slice(0, MAX_ITEMS);
  const t0 = Date.now();
  let router = null;
  try { router = await loadRouter(); } catch { router = null; }
  const res = { added: 0, updated: 0, skipped: 0, notFound: 0, failed: 0 };
  let i = 0;
  const worker = async () => {
    while (i < items.length && Date.now() - t0 < 240e3) {
      const it = items[i++];
      try {
        const r = await enrichConversation(it.convId, { l1: it.l1, l2: it.l2 }, router);
        if (r === "added") res.added++; else if (r === "updated") res.updated++; else if (r === "not_found") res.notFound++; else res.skipped++;
      } catch (e) { res.failed++; console.error(it.convId, e.message); }
    }
  };
  try {
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
  return json({ ok: true, ...res, unfinished: items.length - i });
}
