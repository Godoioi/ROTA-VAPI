// api/argus-webhook.ts
export const config = { runtime: "edge" };


const VAPI_API_KEY = process.env.VAPI_API_KEY!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ARGUS_WEBHOOK_SECRET = process.env.ARGUS_WEBHOOK_SECRET || "";
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || "";

function normalizePhone(v?: string) {
  if (!v || typeof v !== "string") return v;
  return v.replace(/[()\-\s]/g, "");
}

async function callVapiStart(data: any) {
  const to = normalizePhone(data?.callee ?? data?.phoneNumber);
  const from = normalizePhone(data?.caller);
  if (!to) throw new Error("Missing callee/phoneNumber in payload");

  const body: Record<string, any> = {
    to,
    from,
    metadata: { source: "argus", argusId: data?.id },
  };
  const assistantId = data?.assistantId || VAPI_ASSISTANT_ID;
  if (assistantId) body.assistantId = assistantId;

  const res = await fetch("https://api.vapi.ai/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Vapi ${res.status}: ${t}`);
  }
  return res.json(); // { id: "...", ... }
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

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return new Response("Only POST", { status: 405 });

    // 1) Autorização simples por header
    if (ARGUS_WEBHOOK_SECRET) {
      const hdr = req.headers.get("X-Argus-Secret");
      if (hdr !== ARGUS_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // 2) Payload + idempotência
    const payload = await req.json().catch(() => ({}));
    const externalId: string = payload?.id || crypto.randomUUID();

    await upsertArgusEvent({ externalId, eventType: payload?.type, payload });

    // 3) Chama Vapi já no caminho síncrono (modo A - relay)
    const vapi = await callVapiStart(payload);

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
  // deixa registrado nos logs também
  console.error("argus-webhook error:", msg);
  // durante o debug, devolva o erro pro cliente
  return new Response(`error: ${msg}`, { status: 500 });
}
}




