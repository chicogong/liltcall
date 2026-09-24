import { ROOM_CALL_MS, randomToken, type IceResponse } from "../../../packages/protocol/src/index";

export type TurnSecrets = {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  COTURN_HOST?: string;
  COTURN_AUTH_SECRET?: string;
};
const stun: RTCIceServer = { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] };
// Allow a new two-hour call plus some clock/network margin.
export const TURN_TTL_SECONDS = Math.ceil(ROOM_CALL_MS / 1000) + 600;

export async function loadIceConfig(secrets: TurnSecrets, request = fetch): Promise<IceResponse> {
  const { COTURN_HOST: host, COTURN_AUTH_SECRET: sharedSecret } = secrets;
  if (host || sharedSecret) {
    if (!host || !/^[a-zA-Z0-9.-]{1,253}$/.test(host) || host.startsWith(".") || host.endsWith(".")
      || !sharedSecret || !/^[a-f0-9]{64}$/i.test(sharedSecret)) throw new Error("turn_unavailable");
    const expiresAt = Date.now() + TURN_TTL_SECONDS * 1000;
    const username = `${Math.ceil(expiresAt / 1000)}:${randomToken(12)}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sharedSecret),
      { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
    const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return {
      iceServers: [stun, { urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`], username, credential }],
      policy: "relay_allowed",
      expiresAt,
    };
  }
  const { TURN_KEY_ID: id, TURN_KEY_API_TOKEN: token } = secrets;
  if (!id && !token) return { iceServers: [stun], policy: "direct_only" };
  if (!id || !token || !/^[a-f0-9]{32}$/i.test(id)) throw new Error("turn_unavailable");

  let response: Response;
  try {
    response = await request(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { throw new Error("turn_unavailable"); }
  if (response.status !== 201) throw new Error("turn_unavailable");

  let data: unknown;
  try { data = await response.json(); } catch { throw new Error("turn_unavailable"); }
  const supplied = (data as { iceServers?: unknown } | null)?.iceServers;
  if (!Array.isArray(supplied) || supplied.length === 0) throw new Error("turn_unavailable");
  const iceServers: RTCIceServer[] = [];
  let hasRelay = false;
  for (const value of supplied) {
    if (!value || typeof value !== "object") throw new Error("turn_unavailable");
    const candidate = value as Record<string, unknown>;
    const suppliedUrls = Array.isArray(candidate.urls) ? candidate.urls : [candidate.urls];
    // Cloudflare documents port 53 as browser-blocked; remove it before validation.
    const urls = suppliedUrls.filter((url) => typeof url === "string" && !/^turns?:turn\.cloudflare\.com:53(?:\?|$)/.test(url));
    if (!urls.length || !urls.every((url) => typeof url === "string" && /^(stun:stun\.cloudflare\.com:3478|turns?:turn\.cloudflare\.com:(3478|80|5349|443)(\?transport=(udp|tcp))?)$/.test(url))) throw new Error("turn_unavailable");
    const relay = urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
    if (relay && (typeof candidate.username !== "string" || !candidate.username || typeof candidate.credential !== "string" || !candidate.credential)) throw new Error("turn_unavailable");
    hasRelay ||= relay;
    iceServers.push({ urls, ...(relay ? { username: candidate.username as string, credential: candidate.credential as string } : {}) });
  }
  if (!hasRelay) throw new Error("turn_unavailable");
  return { iceServers: [stun, ...iceServers], policy: "relay_allowed", expiresAt: Date.now() + TURN_TTL_SECONDS * 1000 };
}
