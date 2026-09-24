import { describe, expect, it } from "vitest";
import {
  GUEST_RECONNECT_MS, ROOM_CALL_MS, ROOM_WAIT_MS, closeRoom, expireRoom, hashToken, joinRoom, makeRoom,
  parseSignal, randomToken, releaseGuest, releaseIdleGuest, roleForToken,
} from "../packages/protocol/src/index";

describe("room lifecycle", () => {
  const now = 1_000_000;
  const host = "host-hash";
  const invite = "invite-hash";
  it("creates a waiting room with separate host and invite identities", () => {
    const room = makeRoom("room", invite, host, now);
    expect(room.status).toBe("waiting");
    expect(room.expiresAt).toBe(now + ROOM_WAIT_MS);
    expect(roleForToken(room, host)).toBe("host");
    expect(roleForToken(room, invite)).toBeNull();
  });
  it("admits only one guest and extends the call lifetime", () => {
    const room = makeRoom("room", invite, host, now);
    const joined = joinRoom(room, "guest-hash", now + 100)!;
    expect(joined.status).toBe("active");
    expect(joined.guestLeaseUntil).toBe(now + 100 + GUEST_RECONNECT_MS);
    expect(joined.expiresAt).toBe(now + 100 + ROOM_CALL_MS);
    expect(roleForToken(joined, "guest-hash")).toBe("guest");
    expect(joinRoom(joined, "another", now + 200)).toBeNull();
  });
  it("releases an explicitly departing guest so the invite can be reused", () => {
    const joined = joinRoom(makeRoom("room", invite, host, now), "first-guest", now + 100)!;
    const waiting = releaseGuest(joined, now + 200)!;
    expect(waiting.status).toBe("waiting");
    expect(waiting.guest).toBeUndefined();
    expect(waiting.guestLeaseUntil).toBeUndefined();
    expect(roleForToken(waiting, "first-guest")).toBeNull();
    expect(joinRoom(waiting, "second-guest", now + 300)?.guest?.tokenHash).toBe("second-guest");
  });
  it("protects a guest during a short reconnect and releases an idle seat afterward", () => {
    const joined = joinRoom(makeRoom("room", invite, host, now), "first-guest", now)!;
    expect(releaseIdleGuest(joined, now + GUEST_RECONNECT_MS - 1, false)).toBe(joined);
    expect(releaseIdleGuest(joined, now + GUEST_RECONNECT_MS, true)).toBe(joined);
    const waiting = releaseIdleGuest(joined, now + GUEST_RECONNECT_MS, false);
    expect(waiting.status).toBe("waiting");
    expect(waiting.guest).toBeUndefined();
    expect(roleForToken(waiting, "first-guest")).toBeNull();
    expect(releaseIdleGuest({ ...joined, guestLeaseUntil: undefined }, now + 1, false).guest).toBeUndefined();
  });
  it("rejects expiry, guest closing, and revival", () => {
    const room = makeRoom("room", invite, host, now);
    expect(joinRoom(room, "guest", now + ROOM_WAIT_MS)).toBeNull();
    const joined = joinRoom(room, "guest", now)!;
    expect(closeRoom(joined, "guest")).toBeNull();
    const closed = closeRoom(joined, "host")!;
    expect(closed.status).toBe("closed");
    expect(joinRoom(closed, "other", now + 1)).toBeNull();
    expect(expireRoom(joined, joined.expiresAt).status).toBe("expired");
  });
});

describe("tokens and signaling", () => {
  it("generates distinct URL-safe tokens and deterministic hashes", async () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await hashToken(a)).toBe(await hashToken(a));
    expect(await hashToken(a)).not.toBe(await hashToken(b));
  });
  it("only the host can offer and only the guest can answer", () => {
    const offer = { type: "offer", description: { type: "offer", sdp: "v=0\r\ntest" } };
    const answer = { type: "answer", description: { type: "answer", sdp: "v=0\r\ntest" } };
    expect(parseSignal(offer, "host")?.type).toBe("offer");
    expect(parseSignal(offer, "guest")).toBeNull();
    expect(parseSignal(answer, "guest")?.type).toBe("answer");
    expect(parseSignal(answer, "host")).toBeNull();
    expect(parseSignal({ type: "offer", description: { type: "answer", sdp: "v=0" } }, "host")).toBeNull();
    expect(parseSignal({ type: "ice", candidate: { candidate: "x".repeat(5000) } }, "host")).toBeNull();
  });
  it("forwards TURN relay candidates in trickle ICE and SDP", () => {
    expect(parseSignal({ type: "ice", candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 1234 typ relay" } }, "host")?.type).toBe("ice");
    expect(parseSignal({ type: "offer", description: { type: "offer", sdp: "v=0\r\na=candidate:1 1 udp 1 192.0.2.1 1234 typ relay\r\n" } }, "host")?.type).toBe("offer");
  });
  it("preserves the ICE generation and allows only the guest to request a restart", () => {
    const candidate = { candidate: "candidate:1 1 udp 1 192.0.2.1 1234 typ srflx", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "new-generation" };
    expect(parseSignal({ type: "ice", candidate }, "host")).toEqual({ type: "ice", candidate });
    expect(parseSignal({ type: "ice", candidate: { ...candidate, usernameFragment: 10 } }, "host")).toBeNull();
    expect(parseSignal({ type: "restart-request" }, "guest")).toEqual({ type: "restart-request" });
    expect(parseSignal({ type: "restart-request" }, "host")).toBeNull();
  });
  it("accepts only boolean camera state signals", () => {
    expect(parseSignal({ type: "camera", enabled: false }, "guest")).toEqual({ type: "camera", enabled: false });
    expect(parseSignal({ type: "camera", enabled: "false" }, "guest")).toBeNull();
  });
});
