// api/argus-webhook.ts
export const config = { runtime: "edge" };

// ===== ENV =====
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ARGUS_WEBHOOK_SECRET = (process.env.ARGUS_WEBHOOK_SECRET || "").trim();
const VAPI_API_KEY = process.env.VAPI_API_KEY!;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || "";        // obrigatório
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || "";  // ORIGEM (um dos dois)
const VAPI_SIP_TRUNK_ID   = process.env.VAPI_SIP_TRUNK_ID   || "";    // ORIGEM (alternativa)
const DRY_RUN = process.env.DRY_RUN === "1";                           // apenas grava banco

// ===== Utils =====
function onlyDigits(v?: string) { return (v || "").replace(/\D/g, ""); }
function looksLikePlaceholder(s?: string) {
  return typeof s === "string" && /{{\s*.+\s*}}/.test(s);
}
/** Converte vários formatos BR para E.164 (+55DDDN...) — EXIGE DDD. */
function toE164BR(v?: string): string | null {
  if (!v) return null;
  const compact = (v || "").replace(/[()\-\s]/g, "");
  if (/^\+55\d{10,11}$/.test(compact)) return compact;
  const d = onlyDigits(v);
  if (d.startsWith("0055") && (d.length === 14 || d.length === 15)) {
    const rest = d.slice(4); if (rest.length === 10 || rest.length === 11) return "+55" + rest;
  }
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const rest = d.slice(2); if (rest.length === 10 || rest.length === 11) return "+55" + rest;
  }
  if ((d.length === 11 || d.length === 12) && d.startsWith("0")) {
    const s = d.replace(/^0+/, ""); if (s.length === 10 || s.length === 11) return "+55" + s;
  }
  if (d.length === 10 || d.length === 11) return "+55" + d;
  return null;
}

/** Procura um telefone válido no payload inteiro (evita erro quando vier placeholder). */
function extractPhoneBR(data: any): { raw?: string; e164?: string } {
  const candidates = [
    data?.callee, data?.phoneNumber, data?.caller,
    data?.call?.ani, data?.call?.cli, data?.call?.caller,
    data?.customer?.phone, data?.lead?.phone, data?.lead?.telefone, data?.lead?.celular,
    data?.telefone, data?.celular, data?.phone,
  ].filter(Boolean);

  for (const c of candidates) {
    const s = String(c);
    if (looksLikePlaceholder(s)) continue;
    const e = toE164BR(s);
    if (e) return { raw: s, e164: e };
  }

  // Varre qualquer string do JSON (às vezes o Argus envia em outro campo)
  const strings: string[] = [];
  const walk = (o: any) => {
    if (!o) return;
    if (typeof o === "string") strings.push(o);
    else if (Array.isArray(o)) o.forEach(walk);
    else if (typeof o === "object") Object.values(o).forEach(walk);
  };
  walk(data);

  for (const s of strings) {
    if (looksLikePlaceholder(s)) continue;
    const e = toE164BR(s);
    if (e) return { raw: s, e164: e };
  }
  return { raw: undefined, e164: undefined };
}

async function upsertArgusEvent({
  externalId, eventType, payload, patch,
}: { externalId: string; eventType?: string; payload?: any; patch?: Record<string, unknown>; }) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  if (patch) {
    const url = `${SUPABASE_URL}/rest/v1/argus_events?external_id=eq.${encodeURIComponent(externalId)}`;
    const r = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(patch) });
    if (!r.ok) throw new Error(`DB patch ${r.status}: ${await r.text()}`);
    return;
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/argus_events?on_conflict=external_id`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ external_id: externalId, event_type: eventType ?? "unknown", payload: payload ?? {}, status: "received" }]),
  });
  if (!r.ok) throw new Error(`DB insert ${r.status}: ${await r.text()}`);
}

function formatForSipProvider(e164: string) {
  const fmt = (process.env.SIP_DIAL_FORMAT || "E164").toUpperCase(); // E164 | BR_0DDD | BR_55
  const digits = e164.replace(/^\+/, ""); // 55DDDN...
  if (fmt === "BR_0DDD") { if (!digits.startsWith("55")) return e164; return "0" + digits.slice(2); }
  if (fmt === "BR_55")   { return digits; }
  return e164;
}

async function callVapiStart(data: any) {
  // acha número (varre tudo, ignora placeholders)
  const { raw: rawTo, e164 } = extractPhoneBR(data);
  if (!e164) throw new Error(`Invalid phone: expected BR E.164 (+55DDDN...), got: ${rawTo ?? "[none]"}`);

  const assistantId = data?.assistantId || VAPI_ASSISTANT_ID;
  if (!assistantId) throw new Error("Vapi: assistantId is required");

  const phoneNumberId = data?.phoneNumberId || VAPI_PHONE_NUMBER_ID;
  const sipTrunkId   = data?.sipTrunkId   || VAPI_SIP_TRUNK_ID;
  if (!phoneNumberId && !sipTrunkId) throw new Error("Vapi: phoneNumberId or sipTrunkId is required");

  const customerNumber = sipTrunkId ? formatForSipProvider(e164) : e164;

  const body: Record<string, any> = {
    assistantId,
    customer: { number: customerNumber },
    metadata: { source: "argus", argusId: data?.id ?? null },
  };
  if (phoneNumberId) body.phoneNumberId = phoneNumberId;
  if (sipTrunkId)   body.sipTrunkId   = sipTrunkId;

  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Vapi ${res.status}: ${await res.text()}`);
  return res.json();
}

// ===== Handler =====
export default async function handler(req: Request): Promise<Response> {
  let externalId = crypto.randomUUID();
  try {
    if (req.method !== "POST") return new Response("Only POST", { status: 405 });

    // Auth (aceita X-Argus-Secret ou ARGUS_WEBHOOK_SECRET; ignora prefixo Bearer)
    const raw = req.headers.get("X-Argus-Secret") ?? req.headers.get("ARGUS_WEBHOOK_SECRET");
    const provided = raw?.replace(/^Bearer\s+/i, "").trim();
    if (ARGUS_WEBHOOK_SECRET && provided !== ARGUS_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const payload = await req.json().catch(() => ({}));
    externalId = payload?.id || externalId;

    // grava evento
    await upsertArgusEvent({ externalId, eventType: payload?.type, payload });

    if (DRY_RUN) {
      await upsertArgusEvent({ externalId, patch: { status: "queued", processed_at: new Date().toISOString() } });
      return new Response("ok (dry-run)", { status: 200 });
    }

    // chama Vapi
    const vapi = await callVapiStart(payload);

    // atualiza status
    await upsertArgusEvent({
      externalId,
      patch: {
        vapi_call_id: vapi?.id ?? null,
        status: "forwarded_to_vapi",
        processed_at: new Date().toISOString(),
      },
    });

    return new Response("ok", { status: 200 });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error("argus-webhook error:", msg);

    // Se não veio telefone válido, não derruba o Argus: marca no DB e retorna 200.
    if (String(msg).startsWith("Invalid phone")) {
      try {
        await upsertArgusEvent({
          externalId,
          patch: { status: "invalid_phone", error: msg, processed_at: new Date().toISOString() },
        });
      } catch { /* não bloqueia a resposta */ }
      return new Response("ok (no-phone)", { status: 200 });
    }

    // Demais erros: pode devolver 202 pra Argus re-tentar, ou 500 durante debug.
    return new Response(`error: ${msg}`, { status: 500 });
  }
}
