import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { loadIceConfig, TURN_TTL_SECONDS } from "../apps/edge/src/ice";

describe("ICE configuration", () => {
  it("keeps local development STUN-only when no TURN key is configured", async () => {
    expect(await loadIceConfig({})).toEqual({
      iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }],
      policy: "direct_only",
    });
  });
  it("issues short-lived TURN credentials without exposing the long-term key", async () => {
    const secret = { TURN_KEY_ID: "a".repeat(32), TURN_KEY_API_TOKEN: "server-secret" };
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`https://rtc.live.cloudflare.com/v1/turn/keys/${secret.TURN_KEY_ID}/credentials/generate-ice-servers`);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret.TURN_KEY_API_TOKEN}`);
      expect(JSON.parse(String(init?.body))).toEqual({ ttl: TURN_TTL_SECONDS });
      return new Response(JSON.stringify({ iceServers: [
        { urls: "stun:stun.cloudflare.com:3478" },
        { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp", "turn:turn.cloudflare.com:53?transport=udp"], username: "temporary", credential: "temporary-password" },
      ] }), { status: 201 });
    };
    const result = await loadIceConfig(secret, request as typeof fetch);
    expect(result.policy).toBe("relay_allowed");
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 2 * 60 * 60_000);
    expect(result.iceServers[2]).toEqual({ urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "temporary", credential: "temporary-password" });
    expect(JSON.stringify(result)).not.toContain(secret.TURN_KEY_API_TOKEN);
  });
  it("fails closed for incomplete secrets or an upstream error", async () => {
    await expect(loadIceConfig({ TURN_KEY_ID: "a".repeat(32) })).rejects.toThrow("turn_unavailable");
    await expect(loadIceConfig({ TURN_KEY_ID: "a".repeat(32), TURN_KEY_API_TOKEN: "secret" }, async () => new Response("unavailable", { status: 503 }))).rejects.toThrow("turn_unavailable");
    await expect(loadIceConfig({ TURN_KEY_ID: "a".repeat(32), TURN_KEY_API_TOKEN: "secret" }, async () => new Response(JSON.stringify({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] }), { status: 201 }))).rejects.toThrow("turn_unavailable");
  });
  it("signs short-lived coturn REST credentials without returning the shared secret", async () => {
    const secret = "a".repeat(64);
    const result = await loadIceConfig({ COTURN_HOST: "turn.example.org", COTURN_AUTH_SECRET: secret });
    expect(result.policy).toBe("relay_allowed");
    const relay = result.iceServers[1];
    expect(relay.urls).toEqual(["turn:turn.example.org:3478?transport=udp", "turn:turn.example.org:3478?transport=tcp"]);
    expect(relay.username).toMatch(/^\d+:[A-Za-z0-9_-]{16}$/);
    expect(relay.credential).toBe(createHmac("sha1", secret).update(relay.username!).digest("base64"));
    expect(Number(relay.username!.split(":")[0]) * 1000).toBeGreaterThan(Date.now() + 2 * 60 * 60_000);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("fails closed for incomplete or invalid coturn configuration", async () => {
    await expect(loadIceConfig({ COTURN_HOST: "turn.example.org" })).rejects.toThrow("turn_unavailable");
    await expect(loadIceConfig({ COTURN_AUTH_SECRET: "a".repeat(64) })).rejects.toThrow("turn_unavailable");
    await expect(loadIceConfig({ COTURN_HOST: "example.org:443", COTURN_AUTH_SECRET: "a".repeat(64) })).rejects.toThrow("turn_unavailable");
  });
});
