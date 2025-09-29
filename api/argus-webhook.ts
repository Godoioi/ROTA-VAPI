// api/argus-webhook.ts
export const config = {
  runtime: "edge",
  regions: ["gru1", "iad1"], // opcional, GRU é bom p/ BR
};

const VAPI_API_KEY = process.env.VAPI_API_KEY!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function callVapiStart(data: any) {
  const res = await fetch("https://api.vapi.ai/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: data?.callee ?? data?.phoneNumber,
      from: data?.caller ?? undefined,
      metadata: { source: "argus", argusId: data?.id },
    }),
  });
  if (!res.ok) throw new Error(`Vapi ${res.status}: ${await res.text()}`);
  return res.json();
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

  const r = await fetch(`${SUPABASE_URL}/rest/v1/argus_events`, {
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
  });
  if (!r.ok) throw new Error(`DB insert ${r.status}: ${await r.text()}`);
}

// Web padrão (Edge): handler default recebe Request e retorna Response
export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return new Response("Only POST", { status: 405 });

    const payload = await req.json().catch(() => ({}));
    const externalId = (payload && payload.id) || crypto.randomUUID();

    await upsertArgusEvent({ externalId, eventType: payload?.type, payload });

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
    console.error("argus-webhook error:", err?.message || err);
    // 202 permite retry no lado do Argus
    return new Response("accepted", { status: 202 });
  }
}
