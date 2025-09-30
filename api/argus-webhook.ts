export const config = { runtime: "edge" };

// ===== ENV =====
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ARGUS_WEBHOOK_SECRET = (process.env.ARGUS_WEBHOOK_SECRET || "").trim();
const VAPI_API_KEY = process.env.VAPI_API_KEY!;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || ""; // opcional
const DRY_RUN = process.env.DRY_RUN === "1";

// ===== Utils =====
const onlyDigits = (v?: string) => (v || "").replace(/\D/g, "");
const looksLikeTpl = (s?: string) => typeof s === "string" && /\{\{\s*.+\s*\}\}/.test(s);

/** Converte formatos BR em E.164 (+55DDDN...) – exige DDD. */
function toE164BR(v?: string): string | null {
  if (!v) return null;
  const compact = v.replace(/[()\-\s]/g, "");
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

/** "170808|+55..." | "secret=170808;ani=+55..." | "Bearer 170808 +55..." */
function parseSecretAndPhoneFromHeader(h?: string): { secret?: string; phone?: string } {
  if (!h) return {};
  let v = h.replace(/^Bearer\s+/i, "").trim();
  v = v.replace(/secret=/i, "").replace(/ani=|caller=|phone=/gi, "");
  const tokens = v.split(/[,;| ]+/).filter(Boolean);
  let secret: string | undefined;
  let phone: string | undefined;
  for (const t of tokens) {
    const tok = t.trim();
    if (!secret && /^\d{3,}$/.test(tok)) { secret = tok; continue; }
    if (!phone  && /^\+?\d{8,15}$/.test(tok)) { phone = tok; continue; }
  }
  return { secret, phone };
}

function pick<T>(...vals: (T | undefined | null | "")[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v as T;
  return undefined;
}

/** ID estável (hash) quando o Argus não expandir macros. */
async function stableIdFromPayload(payload: any) {
  const enc = new TextEncoder().encode(JSON.stringify(payload ?? {}));
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  return "evt_" + hex.slice(0, 24);
}

/** Procura telefone válido em header/query/path/body (ignora placeholders). */
function extractPhoneBR(payload: any): { raw?: string; e164?: string } {
  const cands = [
    payload?.header_phone, payload?.path_phone, payload?.query_phone,
    payload?.callee, payload?.phoneNumber, payload?.caller,
    payload?.call?.ani, payload?.call?.cli, payload?.call?.caller,
    payload?.customer?.phone, payload?.lead?.phone, payload?.lead?.telefone, payload?.lead?.celular,
    payload?.telefone, payload?.celular, payload?.phone, payload?.to
  ].filter(Boolean);

  for (const c of cands) {
    const s = String(c);
    if (looksLikeTpl(s)) continue;
    const e = toE164BR(s);
    if (e) return { raw: s, e164: e };
  }

  // último recurso: varre strings do JSON
  const strings: string[] = [];
  const walk = (o: any) => {
    if (!o) return;
    if (typeof o === "string") strings.push(o);
    else if (Array.isArray(o)) o.forEach(walk);
    else if (typeof o === "object") Object.values(o).forEach(walk);
  };
  walk(payload);
  for (const s of strings) {
    if (looksLikeTpl(s)) continue;
    const e = toE164BR(s);
    if (e) return { raw: s, e164: e };
  }
  return {};
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

  const r = await fetch(`${SUPABASE_URL}/rest/v1/argus_events`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{
      external_id: externalId,
      event_type: eventType ?? "unknown",
      payload: payload ?? {},
      status: "received",
    }]),
  });
  if (!r.ok) throw new Error(`DB insert ${r.status}: ${await r.text()}`);
}

/** Chama a Vapi (endpoint /calls) com to/from em E.164; assistantId opcional. */
async function callVapiStart(payload: any) {
  const { e164: to } = extractPhoneBR(payload);
  if (!to) throw new Error("invalid_phone: payload não contém número BR válido (+55DDDN...).");

  const from = toE164BR(
    pick<string>(payload?.caller, payload?.from, payload?.call?.ani)
  );

  const body: Record<string, any> = {
    to, from,
    metadata: { source: "argus", argusId: pick<string>(payload?.id, payload?.call?.id) }
  };
  const assistantId = payload?.assistantId || VAPI_ASSISTANT_ID;
  if (assistantId) body.assistantId = assistantId;

  const res = await fetch("https://api.vapi.ai/calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`vapi_${res.status}: ${await res.text()}`);
  return res.json(); // { id: "..." }
}

// ===== Handler =====
export default async function handler(req: Request): Promise<Response> {
  // Apenas POST
  if (req.method !== "POST") return new Response("Only POST", { status: 405 });

  // Header: X-Argus-Secret (com ou sem ANI)
  const secHeader = req.headers.get("X-Argus-Secret") ?? req.headers.get("Authorization") ?? "";
  const { secret: headerSecret, phone: headerPhone } = parseSecretAndPhoneFromHeader(secHeader);
  if (ARGUS_WEBHOOK_SECRET && headerSecret !== ARGUS_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Body (json ou texto)
  const ct = req.headers.get("content-type") || "";
  let payload: any = {};
  if (ct.includes("application/json")) {
    payload = await req.json().catch(() => ({}));
  } else {
    const text = await req.text();
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  }
  // 👇 ADICIONE ESTE BLOCO
  if (typeof payload === "string") {
  try { payload = JSON.parse(payload); } catch {}
  }
  // Enriquecimentos
  const url = new URL(req.url);
  const qPhone = url.searchParams.get("ani") || url.searchParams.get("phone") || url.searchParams.get("caller");
  if (qPhone) payload.query_phone = qPhone;
  const parts = url.pathname.split("/").filter(Boolean);
  const tail = decodeURIComponent(parts[parts.length - 1] || "");
  if (/^\+?\d[\d()\-.\s]+$/.test(tail)) payload.path_phone = tail;
  if (headerPhone) payload.header_phone = headerPhone;

  // externalId: tenta vários; se vier placeholder, gera ID estável
  let externalId = pick<string>(payload?.id, payload?.callId, payload?.call?.id) || "";
  if (!externalId || looksLikeTpl(externalId)) externalId = await stableIdFromPayload(payload);

  // grava recebido
  try {
    await upsertArgusEvent({ externalId, eventType: payload?.type, payload });
  } catch {
    return new Response("db_error", { status: 202 });
  }

  // Dry-run (para testar sem ligar para a Vapi)
  if (DRY_RUN) {
    await upsertArgusEvent({
      externalId,
      patch: { status: "queued", processed_at: new Date().toISOString(), error: null },
    });
    return new Response("ok (dry-run)", { status: 200 });
  }

  // chama Vapi
  try {
    const vapi = await callVapiStart(payload);
    await upsertArgusEvent({
      externalId,
      patch: {
        vapi_call_id: vapi?.id ?? null,
        status: "forwarded_to_vapi",
        processed_at: new Date().toISOString(),
        error: null
      },
    });
    return new Response("ok", { status: 200 });
  } catch (err: any) {
    const msg = String(err?.message || err);
    // marca erro detalhado para debug
    await upsertArgusEvent({
      externalId,
      patch: {
        status: msg.startsWith("invalid_phone") ? "invalid_phone" : "vapi_error",
        error: msg,
        processed_at: new Date().toISOString()
      },
    });
    // 200 para o Argus não insistir demais (ou troque para 202 se quiser re-tentativa)
    return new Response("ok (error logged)", { status: 200 });
  }
}

