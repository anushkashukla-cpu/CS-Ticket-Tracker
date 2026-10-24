// Freshchat sends every chat event here in real time.
// Set this URL in Freshchat → Admin → Webhooks: https://<your-project>.vercel.app/api/freshchat-webhook
import { json, verifySignature, findConversationId, partsText, upsertConversation, missingEnv } from "./_lib.js";

export async function POST(request) {
  const missing = missingEnv();
  if (missing.length) return json({ ok: false, error: "Missing environment variables: " + missing.join(", ") }, 500);

  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-freshchat-signature"))) {
    console.warn("Rejected webhook: signature didn't match");
    return json({ ok: false, error: "invalid signature" }, 401);
  }

  let ev;
  try { ev = JSON.parse(raw); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }

  const convId = findConversationId(ev.data);
  if (!convId) return json({ ok: true, skipped: "no conversation in event" });

  let userMsg = null;
  const m = ev.data && ev.data.message;
  if (ev.action === "message_create" && m && m.actor_type === "user" && (m.message_type || "normal") === "normal") {
    userMsg = { id: m.id || "", text: partsText(m.message_parts || m.msg_parts), source: m.message_source || "" };
  }

  try {
    const res = await upsertConversation(convId, userMsg);
    console.log(ev.action, convId, JSON.stringify(res));
    return json({ ok: true, action: ev.action, ...res });
  } catch (e) {
    console.error(ev.action, convId, e.message);
    return json({ ok: false, error: e.message }, 500); // non-200 lets Freshchat retry
  }
}

// Visiting the URL in a browser shows whether the function is set up.
export function GET() {
  const missing = missingEnv();
  return json({ ok: missing.length === 0, service: "freshchat-webhook", missing });
}
