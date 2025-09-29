// api/argus-webhook.ts
export const config = { runtime: "edge" };

// ====== ENV ======
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ARGUS_WEBHOOK_SECRET = process.env.ARGUS_WEBHOOK_SECRET || "";
const VAPI_API_KEY = process.env.VAPI_API_KEY!;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || "";      // opcional (recomendado)
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || ""; // opcional (origem)
const VAPI_SIP_TRUNK_ID = process.env.VAPI_SIP_TRUNK_ID || "";       // opcional (origem via SIP)
const DRY_RUN = process.env.DRY_RUN === "1";                          // opcional

function requireEnv(name: string, optional = false) {
  const v = (process.env as any)[name];
  if (!v && !optional) throw new Error(`Missing env: ${name}`);
  return v as string;
}

// ====== Utils ======
function normalizePhone(v?: string) {
  if (!v || typeof v !== "string") return v;
  // remove espaços/parênteses/hífens; mantém o '+' se existir
  return v.replace(/[()\-\s]/g, "");
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
    const r = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`DB patch ${r.status}: ${await r.text()}`);
    return;
  }

  // upsert de verdade (merge-duplicates) com base no índice único external_id
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
  const to = normalizePhone(data?.callee ?? data?.phoneNumber);
  if (!to) throw new Error("Missing destination: callee/phoneNumber");

  const assistantId = data?.assistantId || VAPI_ASSISTANT_ID;
  if (!assistantId) throw new Error("Vapi: assistantId is required");

  // origem: preferir phoneNumberId; se não houver, tentar sipTrunkId
  const phoneNumberId = data?.phoneNumberId || VAPI_PHONE_NUMBER_ID;
  const sipTrunkId = data?.sipTrunkId || VAPI_SIP_TRUNK_ID;
  if (!phoneNumberId && !sipTrunkId) {
    throw new Error("Vapi: phoneNumberId or sipTrunkId is required");
  }

  const body: Record<string, any> = {
    assistantId,
    customer: { number: to }, // E.164: +55...
    metadata: { source: "argus", argusId: data?.id ?? null },
  };
  if (phoneNumberId) body.phoneNumberId = phoneNumberId;
  if (sipTrunkId) body.sipTrunkId = sipTrunkId;

  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("VAPI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Vapi ${res.status}: ${await res.text()}`);
  return res.json(); // geralmente { id: "...", ... }
}

// ====== Handler ======
export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") {
      return new Response("Only POST", { status: 405 });
    }

    // 1) valida o segredo do Argus (se configurado)
    if (ARGUS_WEBHOOK_SECRET) {
      const hdr = req.headers.get("X-Argus-Secret");
      if (hdr !== ARGUS_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // 2) payload e idempotência
    const payload = await req.json().catch(() => ({}));
    const externalId: string = payload?.id || crypto.randomUUID();

    // 3) registra/atualiza no Supabase
    await upsertArgusEvent({
      externalId,
      eventType: payload?.type,
      payload,
    });

    // 4) Modo DRY_RUN: não chama a Vapi; marca como 'queued'
    if (DRY_RUN) {
      await upsertArgusEvent({
        externalId,
        patch: {
          status: "queued",
          processed_at: new Date().toISOString(),
        },
      });
      return new Response("ok (dry-run)", { status: 200 });
    }

    // 5) chama a Vapi agora (modo relay)
    const vapi = await callVapiStart(payload);

    // 6) atualiza status e id da Vapi
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
    // Durante a depuração devolvemos 500 com a mensagem.
    // (Depois, se preferir, troque para: return new Response("accepted", { status: 202 });)
    return new Response(`error: ${msg}`, { status: 500 });
  }
}
