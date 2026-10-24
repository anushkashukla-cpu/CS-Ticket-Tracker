// Shared helpers for the Freshchat → tracker sync (Vercel serverless functions).
// Files starting with "_" are not exposed as routes by Vercel.
import crypto from "node:crypto";

const env = (k, d = "") => String(process.env[k] ?? d).trim();

export const CFG = {
  fcBase: env("FRESHCHAT_BASE", "https://homerun-team-d09d641d432c3b917703943.freshchat.com/v2").replace(/\/$/, ""),
  fcKey: env("FRESHCHAT_API_KEY"),
  trackerKey: env("TRACKER_KEY"),
  fbKey: env("FIREBASE_API_KEY"),
  fbProject: env("FIREBASE_PROJECT_ID", "homerun-cs-tracker"),
  l1Field: env("L1_FIELD", "cf_issue_subcategory"), // Freshchat "Category"
  l2Field: env("L2_FIELD", "cf_root_cause"),        // Freshchat "Subcategory"
};

export function missingEnv() {
  return ["FRESHCHAT_API_KEY", "TRACKER_KEY", "FIREBASE_API_KEY"].filter((k) => !env(k));
}

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function http(url, opts = {}, tries = 4) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      last = await fetch(url, opts);
      if (last.status !== 429 && last.status < 500) return last;
    } catch (e) {
      if (a === tries - 1) throw e;
    }
    await sleep(Math.min(8000, 400 * 2 ** a));
  }
  return last;
}

/* ---------------- Freshchat ---------------- */
export async function fcGet(path) {
  const r = await http(CFG.fcBase + path, { headers: { Authorization: "Bearer " + CFG.fcKey, Accept: "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Freshchat ${r.status} on ${path}`);
  return r.json();
}

let channelCache = null;
export async function channelLabel(channelId, messageSource) {
  if (messageSource === "mobile") return "App chat";
  if (messageSource === "web") return "Web chat";
  if (!channelId) return "";
  if (!channelCache) {
    channelCache = {};
    try {
      const j = await fcGet("/channels?items_per_page=100");
      for (const c of (j && j.channels) || []) channelCache[c.id] = c.name || "";
    } catch (e) {
      console.warn("Couldn't load Freshchat channels:", e.message);
    }
  }
  const name = channelCache[channelId] || "";
  if (/whatsapp/i.test(name)) return "WhatsApp";
  return name;
}

export function partsText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((x) => {
      if (x.text) return String(x.text.content || "");
      if (x.part_type === "text" && x.properties) return String(x.properties.text || "");
      if (x.image || x.part_type === "image") return "[image]";
      if (x.file || x.part_type === "file") return "[file]";
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function findConversationId(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 6) return "";
  if (typeof o.conversation_id === "string" && o.conversation_id) return o.conversation_id;
  for (const v of Object.values(o)) {
    const f = findConversationId(v, depth + 1);
    if (f) return f;
  }
  return "";
}

/* Freshchat signs each webhook body with RSA-SHA256; the public key is in its webhook settings. */
export function verifySignature(raw, sig) {
  if (env("FRESHCHAT_WEBHOOK_VERIFY") === "off") return true;
  const pem = normalizePem(env("FRESHCHAT_WEBHOOK_PUBLIC_KEY"));
  if (!pem || !sig) return false;
  try {
    return crypto.verify("RSA-SHA256", Buffer.from(raw, "utf8"), crypto.createPublicKey(pem), Buffer.from(sig, "base64"));
  } catch (e) {
    console.error("Signature check failed:", e.message);
    return false;
  }
}
function normalizePem(v) {
  if (!v) return "";
  v = v.replace(/\\n/g, "\n").trim();
  if (/-----BEGIN/.test(v)) return v;
  const body = v.replace(/\s+/g, "").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

/* ---------------- Firestore (REST; access is controlled by the tracker key in the path) ---------------- */
const fsRoot = () =>
  `https://firestore.googleapis.com/v1/projects/${CFG.fbProject}/databases/(default)/documents/workspaces/${encodeURIComponent(CFG.trackerKey)}`;

function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { stringValue: String(v) };
}
function dec(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) {
    if ("stringValue" in v) out[k] = v.stringValue;
    else if ("booleanValue" in v) out[k] = v.booleanValue;
    else if ("integerValue" in v) out[k] = Number(v.integerValue);
    else if ("doubleValue" in v) out[k] = v.doubleValue;
    else if ("nullValue" in v) out[k] = null;
    else if ("arrayValue" in v) out[k] = ((v.arrayValue && v.arrayValue.values) || []).map((x) => dec({ x }).x);
  }
  return out;
}

export async function fsGetPath(path) {
  const r = await http(`${fsRoot()}/${path}?key=${CFG.fbKey}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore read ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return dec((await r.json()).fields);
}
export async function fsSetPath(path, data) {
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)]));
  const r = await http(`${fsRoot()}/${path}?key=${CFG.fbKey}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`Firestore write ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export const docId = (convId) => "c_" + String(convId).replace(/[^A-Za-z0-9_\-~:@+]/g, "_").slice(0, 150);

export async function fsGet(id) {
  const r = await http(`${fsRoot()}/tickets/${id}?key=${CFG.fbKey}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore read ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return dec((await r.json()).fields);
}

/* exists: true = must exist, false = must not exist, undefined = either */
export async function fsPatch(id, data, exists) {
  const mask = Object.keys(data).map((k) => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  const cond = exists === undefined ? "" : `&currentDocument.exists=${exists}`;
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)]));
  const r = await http(`${fsRoot()}/tickets/${id}?key=${CFG.fbKey}${cond}&${mask}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (r.ok) return true;
  const txt = await r.text();
  if (/FAILED_PRECONDITION|NOT_FOUND|ALREADY_EXISTS/.test(txt)) return false;
  throw new Error(`Firestore write ${r.status}: ${txt.slice(0, 200)}`);
}

export async function fsListAll(collectionId, limit = 1000) {
  const r = await http(`${fsRoot()}:runQuery?key=${CFG.fbKey}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], limit } }),
  });
  if (!r.ok) throw new Error(`Firestore query ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).filter((x) => x.document).map((x) => ({ id: x.document.name.split("/").pop(), ...dec(x.document.fields) }));
}

/* Auto-assignment: same matching as the tracker page (L1+L2, then L2 alone; names match full or first name). */
const rk = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
export async function loadRouter() {
  const [routes, owners] = await Promise.all([fsListAll("routing"), fsListAll("owners")]);
  const find = (n) => owners.find((o) => rk(o.name) === rk(n)) || owners.find((o) => rk(String(o.name).split(/\s+/)[0]) === rk(n));
  return function route(l1, l2) {
    if (!l2) return null;
    const r = routes.find((x) => rk(x.l1) + "|" + rk(x.l2) === rk(l1) + "|" + rk(l2)) || routes.find((x) => rk(x.l2) === rk(l2));
    if (!r) return null;
    const list = [];
    for (const n of r.owners || []) { const o = find(n); if (o && !list.includes(o)) list.push(o); }
    if (!list.length) return null;
    return {
      ownerId: list[0].id, ownerIds: list.map((o) => o.id), ownerName: list.map((o) => o.name).join(", "),
      ownerEmail: list.filter((o) => o.email).map((o) => o.email).join(","), assignedAt: new Date().toISOString(),
      assignedBy: "auto", autoAssigned: true, autoAssignOff: false,
    };
  };
}

export async function fsUntagged(limit = 500) {
  const r = await http(`${fsRoot()}:runQuery?key=${CFG.fbKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "tickets" }],
        where: { fieldFilter: { field: { fieldPath: "l1" }, op: "EQUAL", value: { stringValue: "" } } },
        limit,
      },
    }),
  });
  if (!r.ok) throw new Error(`Firestore query ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json())
    .filter((x) => x.document)
    .map((x) => ({ id: x.document.name.split("/").pop(), ...dec(x.document.fields) }));
}

/* ---------------- Ticket upsert ---------------- */
export const ORDER_RE = /HR\/\d{2}\/\d{4,7}/;
export const clean = (v) => {
  const s = v == null ? "" : String(v).replace(/\s+/g, " ").trim();
  return /^(none|null|\(blank\))$/i.test(s) ? "" : s;
};
export const iso = (t) => {
  const d = t ? new Date(t) : null;
  return d && !isNaN(d) ? d.toISOString() : "";
};

/**
 * Bring one conversation into the tracker.
 * userMsg: { id, text, source } when the event is a new customer message.
 */
export async function upsertConversation(convId, userMsg) {
  const conv = await fcGet("/conversations/" + encodeURIComponent(convId));
  if (!conv) return { skipped: "conversation not found in Freshchat" };
  const props = conv.properties || {};
  const l1 = clean(props[CFG.l1Field]);
  const l2 = clean(props[CFG.l2Field]);
  const id = docId(convId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await fsGet(id);
    if (!cur && !(userMsg && userMsg.text) && !l1) return { skipped: "no customer message yet" };
    const now = new Date().toISOString();
    const patch = cur
      ? {}
      : {
          createdAt: iso(conv.created_time) || now, l1: "", l2: "", orderId: "", channel: "", message: "",
          activeOrder: "", userMsgCount: 0, importedAt: now,
        };
    Object.assign(patch, { convId, chatUrl: conv.url || (cur && cur.chatUrl) || "", status: conv.status || "", syncedAt: now, source: "freshchat-api" });

    if (!(cur && cur.tagManual)) {
      if (l1) patch.l1 = l1;
      if (l2) patch.l2 = l2;
    }
    if (!(cur && cur.channel)) {
      const ch = await channelLabel(conv.channel_id, userMsg && userMsg.source);
      if (ch) patch.channel = ch;
    }
    const importedEarlier = cur && cur.message && cur.userMsgCount == null; // row came from a CSV import
    if (userMsg && userMsg.text && !importedEarlier && userMsg.id !== (cur && cur.lastUserMsgId)) {
      const count = (cur && cur.userMsgCount) || 0;
      if (count < 3) {
        const prev = (cur && cur.message) || "";
        patch.message = (prev ? prev + " / " : "") + userMsg.text;
        patch.message = patch.message.slice(0, 1500);
        patch.userMsgCount = count + 1;
      }
      patch.lastUserMsgId = userMsg.id || "";
    }
    if (!(cur && cur.orderId)) {
      const m = ((userMsg && userMsg.text) || "").match(ORDER_RE);
      if (m) patch.orderId = m[0];
      else if (clean(props.cf_order_number)) patch.orderId = clean(props.cf_order_number);
    }
    if (await fsPatch(id, patch, !!cur)) return { ok: true, created: !cur, l1: patch.l1 ?? (cur && cur.l1), l2: patch.l2 ?? (cur && cur.l2) };
    // Another event created or changed the row at the same moment; read again and retry.
  }
  throw new Error("Couldn't save the ticket after 3 attempts");
}

export async function refreshTags(ticket, router) {
  const conv = await fcGet("/conversations/" + encodeURIComponent(ticket.convId));
  if (!conv) return false;
  const props = conv.properties || {};
  const l1 = clean(props[CFG.l1Field]), l2 = clean(props[CFG.l2Field]);
  const patch = { syncedAt: new Date().toISOString() };
  if (!l1 && !l2) { await fsPatch(ticket.id, patch, true); return false; }
  if (l1) patch.l1 = l1;
  if (l2) patch.l2 = l2;
  if (!ticket.orderId && clean(props.cf_order_number)) patch.orderId = clean(props.cf_order_number);
  if (router && !ticket.ownerId && !ticket.autoAssignOff) { const a = router(l1 || ticket.l1, l2 || ticket.l2); if (a) Object.assign(patch, a); }
  return fsPatch(ticket.id, patch, true);
}
