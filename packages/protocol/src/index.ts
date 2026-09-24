export const ROOM_WAIT_MS = 30 * 60_000;
export const ROOM_CALL_MS = 2 * 60 * 60_000;
export const GUEST_RECONNECT_MS = 30_000;
export const TICKET_MS = 30_000;

export type Role = "host" | "guest";
export type IceResponse = { iceServers: RTCIceServer[]; policy: "direct_only" | "relay_allowed"; expiresAt?: number };
export type RoomStatus = "waiting" | "active" | "closed" | "expired";
export type Member = { id: string; tokenHash: string };
export type RoomRecord = {
  id: string;
  inviteHash: string;
  host: Member;
  guest?: Member;
  guestLeaseUntil?: number;
  status: RoomStatus;
  createdAt: number;
  expiresAt: number;
};

export type Signal =
  | { type: "offer"; description: { type: "offer"; sdp: string } }
  | { type: "answer"; description: { type: "answer"; sdp: string } }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: "restart-request" }
  | { type: "camera"; enabled: boolean };

export function randomToken(bytes = 24): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function makeRoom(id: string, inviteHash: string, hostTokenHash: string, now: number): RoomRecord {
  return {
    id,
    inviteHash,
    host: { id: randomToken(12), tokenHash: hostTokenHash },
    status: "waiting",
    createdAt: now,
    expiresAt: now + ROOM_WAIT_MS,
  };
}

export function expireRoom(room: RoomRecord, now: number): RoomRecord {
  if (room.status === "closed" || room.status === "expired" || now < room.expiresAt) return room;
  return { ...room, status: "expired" };
}

export function joinRoom(room: RoomRecord, guestTokenHash: string, now: number): RoomRecord | null {
  const current = expireRoom(room, now);
  if (current.status !== "waiting" || current.guest) return null;
  return {
    ...current,
    guest: { id: randomToken(12), tokenHash: guestTokenHash },
    guestLeaseUntil: now + GUEST_RECONNECT_MS,
    status: "active",
    expiresAt: now + ROOM_CALL_MS,
  };
}

export function releaseGuest(room: RoomRecord, now: number): RoomRecord | null {
  const current = expireRoom(room, now);
  if (current.status !== "active" || !current.guest) return null;
  const next = { ...current };
  delete next.guest;
  delete next.guestLeaseUntil;
  return { ...next, status: "waiting", expiresAt: Math.min(current.expiresAt, now + ROOM_WAIT_MS) };
}

export function releaseIdleGuest(room: RoomRecord, now: number, guestConnected: boolean): RoomRecord {
  const current = expireRoom(room, now);
  if (current.status !== "active" || !current.guest || guestConnected || (current.guestLeaseUntil ?? 0) > now) return current;
  return releaseGuest(current, now) ?? current;
}

export function roleForToken(room: RoomRecord, tokenHash: string): Role | null {
  if (room.host.tokenHash === tokenHash) return "host";
  if (room.guest?.tokenHash === tokenHash) return "guest";
  return null;
}

export function closeRoom(room: RoomRecord, role: Role): RoomRecord | null {
  if (role !== "host" || room.status === "closed" || room.status === "expired") return null;
  return { ...room, status: "closed" };
}

export function parseSignal(value: unknown, role: Role): Signal | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.type === "offer" || v.type === "answer") {
    if ((v.type === "offer" && role !== "host") || (v.type === "answer" && role !== "guest")) return null;
    const d = v.description as Record<string, unknown> | null;
    if (!d || d.type !== v.type || typeof d.sdp !== "string" || d.sdp.length > 48_000 || !d.sdp.startsWith("v=0")) return null;
    return { type: v.type, description: { type: v.type, sdp: d.sdp } } as Signal;
  }
  if (v.type === "ice") {
    const c = v.candidate as Record<string, unknown> | null;
    if (!c || typeof c.candidate !== "string" || c.candidate.length > 4096) return null;
    if (c.sdpMid !== undefined && c.sdpMid !== null && typeof c.sdpMid !== "string") return null;
    if (c.sdpMLineIndex !== undefined && c.sdpMLineIndex !== null && typeof c.sdpMLineIndex !== "number") return null;
    if (c.usernameFragment !== undefined && (typeof c.usernameFragment !== "string" || c.usernameFragment.length > 256)) return null;
    return { type: "ice", candidate: {
      candidate: c.candidate,
      sdpMid: c.sdpMid as string | null | undefined,
      sdpMLineIndex: c.sdpMLineIndex as number | null | undefined,
      usernameFragment: c.usernameFragment as string | undefined,
    } };
  }
  if (v.type === "restart-request" && role === "guest") return { type: "restart-request" };
  if (v.type === "camera" && typeof v.enabled === "boolean") return { type: "camera", enabled: v.enabled };
  return null;
}
