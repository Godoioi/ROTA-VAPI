// api/argus-webhook.ts
export const config = { runtime: "edge" };

// ===== ENV =====
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ARGUS_WEBHOOK_SECRET = process.env.ARGUS_WEBHOOK_SECRET || "";
const VAPI_API_KEY = process.env.VAPI_API_KEY!;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || "";        // obrigatório para a Vapi (se não vier no payload)
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || "";  // origem (um dos dois é obrigatório)
const VAPI_SIP_TRUNK_ID = process.env.VAPI_SIP_TRUNK_ID || "";        // origem (alternativa)
const DRY_RUN = process.env.DRY_RUN === "1";                           // para testar só o DB

// ===== Utils =====
function onlyDigits(v?: string) {
  return (v || "").replace(/\D/g, "");
}

/** Converte vários formatos BR para E.164 (+55DDDN...) — EXIGE DDD. */
function toE164BR(v?: string): string | null {
  if (!v) return null;

  const compact = (v || "").replace(/[()\-\s]/g, "");
  // já está em +55 e 10/11 dígitos?
  if (/^\+55\d{10,11}$/.test(compact)) return compact;

  const d = onlyDigits(v);

  // 0055DDDN... → +55DDDN...
  if (d.startsWith("0055") && (d.length === 14 || d.length === 15)) {
    const rest = d.slice(4);
    if (rest.length === 10 || rest.length === 11) return "+55" + rest;
  }

  // 55DDDN... (sem +)
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const rest = d.slice(2);
    if (rest.length === 10 || rest.length === 11) return "+55" + rest;
  }

  // 0DDDN... → remove "0" de tronco
  if ((d.length === 11 || d.length === 12) && d.startsWith("0")) {
    const s = d.replace(/^0+/, "");
    if (s.length === 10 || s.length === 11) return "+55" + s;
  }

  // Nacional com DDD (10 = fixo, 11 = móvel)
  if (d.length === 10 || d.length === 11) return "+55" + d;

  // Se veio sem DDD (8/9 dígitos), não inferimos para não discar errado.
  return null;
}

async function upsertArgusEvent({
  externalId,
  eventType,
  payload,
  patch,
}: {
  externalId: string;
  eventType?: string;
  payload?: any;
  patch?: Record<string, unknown>;
}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  if (patch) {
    const url = `${SUPABASE_URL}/rest/v1/argus_events?external_id=eq.${encodeURIComponent(
      externalId
    )}`;
    const r = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(patch) });
    if (!r.ok) throw new Error(`DB patch ${r.status}: ${await r.text()}`);
    return;
  }

  // Upsert por external_id
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/argus_events?on_conflict=external_id`,
    {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([
        {
          external_id: externalId,
          event_type: eventType ?? "unknown",
          payload: payload ?? {},
          status: "received",
        },
      ]),
    }
  );
  if (!r.ok) throw new Error(`DB insert ${r.status}: ${await r.text()}`);
}

async function callVapiStart(data: any) {
  // destino
  const rawTo = data?.callee ?? data?.phoneNumber;
  const to = toE164BR(rawTo);
  if (!to) throw new Error(`Invalid phone: expected BR E.164 (+55DDDN...), got: ${rawTo}`);

  // assistant
  const assistantId = data?.assistantId || VAPI_ASSISTANT_ID;
  if (!assistantId) throw new Error("Vapi: assistantId is required");

  // origem (um dos dois)
  const phoneNumberId = data?.phoneNumberId || VAPI_PHONE_NUMBER_ID;
  const sipTrunkId = data?.sipTrunkId || VAPI_SIP_TRUNK_ID;
  if (!phoneNumberId && !sipTrunkId) {
    throw new Error("Vapi: phoneNumberId or sipTrunkId is required");
  }

  const body: Record<string, any> = {
    assistantId,
    customer: { number: to },
    metadata: { source: "argus", argusId: data?.id ?? null },
  };
  if (phoneNumberId) body.phoneNumberId = phoneNumberId;
  if (sipTrunkId) body.sipTrunkId = sipTrunkId;

  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Vapi ${res.status}: ${await res.text()}`);
  return res.json(); // { id: "...", ... }
}

// ===== Handler =====
export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return new Response("Only POST", { status: 405 });

    // autenticação por header (aceita os dois nomes)
    const hdr =
      req.headers.get("X-Argus-Secret") ?? req.headers.get("ARGUS_WEBHOOK_SECRET");
    if (ARGUS_WEBHOOK_SECRET && hdr !== ARGUS_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const payload = await req.json().catch(() => ({}));
    const externalId: string = payload?.id || crypto.randomUUID();

    // registra evento (idempotente)
    await upsertArgusEvent({ externalId, eventType: payload?.type, payload });

    if (DRY_RUN) {
      await upsertArgusEvent({
        externalId,
        patch: { status: "queued", processed_at: new Date().toISOString() },
      });
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
    // durante os testes devolvemos 500 com detalhe; depois pode mudar para 202 se quiser.
    return new Response(`error: ${msg}`, { status: 500 });
  }
}
