import { DurableObject } from "cloudflare:workers";
import {
  GUEST_RECONNECT_MS, TICKET_MS, closeRoom, hashToken, joinRoom, makeRoom, parseSignal,
  releaseGuest, releaseIdleGuest,
  randomToken, roleForToken, type Role, type RoomRecord,
} from "../../../packages/protocol/src/index";
import { loadIceConfig } from "./ice";

type Env = {
  ROOMS: DurableObjectNamespace<Room>;
  ROOM_CREATION_LIMIT: RateLimit;
  APP_ORIGIN: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  COTURN_HOST?: string;
  COTURN_AUTH_SECRET?: string;
};
type Ticket = { role: Role; memberId: string; expiresAt: number };
type Attachment = { role?: Role; memberId?: string; openedAt: number; windowStart?: number; messageCount?: number };
const MAX_PENDING_TICKETS = 12;
const MAX_SIGNALS_PER_WINDOW = 120;
const SIGNAL_WINDOW_MS = 10_000;

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers });
}
function fail(code: string, status: number): Response { return json({ error: code }, status); }
function bearer(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}
function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 4096) return null;
    const data: unknown = await request.json();
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch { return null; }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    if (origin && origin !== env.APP_ORIGIN) return fail("origin_not_allowed", 403);
    if (request.method === "OPTIONS") {
      const preflight = new Response(null, { status: 204 });
      return cors(preflight, env.APP_ORIGIN);
    }
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") return cors(json({ ok: true }), env.APP_ORIGIN);

    let response: Response;
    if (url.pathname === "/v1/rooms" && request.method === "POST") {
      // This is only a soft abuse brake: counters are per Cloudflare location,
      // not a global spend cap. Cloudflare supplies this header at the edge.
      const address = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.ROOM_CREATION_LIMIT.limit({ key: `create:${address}` });
      if (!success) return cors(json({ error: "rate_limited" }, 429), env.APP_ORIGIN);
      const id = randomToken(18);
      const inviteToken = randomToken();
      const sessionToken = randomToken();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      response = await stub.fetch(new Request("https://room/internal/create", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, inviteToken, sessionToken }),
      }));
    } else {
      const match = /^\/v1\/rooms\/([A-Za-z0-9_-]{24})\/(join|session|ws-ticket|ice-servers|leave|close|ws)$/.exec(url.pathname);
      if (!match) return cors(fail("not_found", 404), env.APP_ORIGIN);
      const [, id, action] = match;
      const allowed: Record<string, string> = {
        join: "POST", session: "GET", "ws-ticket": "POST", "ice-servers": "GET", leave: "POST", close: "POST", ws: "GET",
      };
      if (request.method !== allowed[action]) return cors(fail("method_not_allowed", 405), env.APP_ORIGIN);
      if (action === "ws" && request.headers.get("upgrade")?.toLowerCase() !== "websocket") return fail("upgrade_required", 426);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      if (action === "ice-servers") {
        const auth = await stub.fetch(new Request("https://room/internal/session", { headers: request.headers }));
        if (!auth.ok) return cors(auth, env.APP_ORIGIN);
        const address = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.ROOM_CREATION_LIMIT.limit({ key: `ice:${id}:${address}` });
        if (!success) return cors(fail("rate_limited", 429), env.APP_ORIGIN);
        try { response = json(await loadIceConfig(env)); }
        catch { response = fail("turn_unavailable", 503); }
      } else {
        const internal = { join: "join", session: "session", "ws-ticket": "ticket", leave: "leave", close: "close", ws: "ws" }[action];
        let body: string | undefined;
        if (request.method === "POST") {
          body = await request.text();
          if (body.length > 4096) return cors(fail("bad_request", 400), env.APP_ORIGIN);
        }
        response = await stub.fetch(new Request(`https://room/internal/${internal}`, {
          method: request.method, headers: request.headers, body,
        }));
      }
    }
    return response.status === 101 ? response : cors(response, env.APP_ORIGIN);
  },
};

function cors(response: Response, origin: string): Response {
  const h = new Headers(response.headers);
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  h.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers: h });
}

export class Room extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/internal/create" && request.method === "POST") {
      if (await this.ctx.storage.get("room")) return fail("room_exists", 409);
      const body = await readJson(request);
      if (!body || typeof body.id !== "string" || !validToken(body.inviteToken) || !validToken(body.sessionToken)) return fail("bad_request", 400);
      const room = makeRoom(body.id, await hashToken(body.inviteToken), await hashToken(body.sessionToken), Date.now());
      await this.save(room);
      return json({ roomId: room.id, inviteToken: body.inviteToken, sessionToken: body.sessionToken,
        participantId: room.host.id, role: "host", expiresAt: room.expiresAt }, 201);
    }
    const room = await this.load();
    if (!room) return fail("room_not_found", 404);
    if (room.status === "closed" || room.status === "expired") return fail("room_unavailable", 410);

    if (path === "/internal/join" && request.method === "POST") {
      const body = await readJson(request);
      if (!body || !validToken(body.inviteToken)) return fail("bad_request", 400);
      if (await hashToken(body.inviteToken) !== room.inviteHash) return fail("invalid_invite", 403);
      const sessionToken = randomToken();
      const guestHash = await hashToken(sessionToken);
      const joined = await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<RoomRecord>("room");
        if (!latest || latest.inviteHash !== room.inviteHash) return null;
        const result = joinRoom(latest, guestHash, Date.now());
        if (result) await txn.put("room", result);
        return result;
      });
      if (!joined) return fail("room_full", 409);
      await this.scheduleAlarm(joined);
      return json({ roomId: joined.id, sessionToken, participantId: joined.guest!.id,
        role: "guest", expiresAt: joined.expiresAt }, 201);
    }

    const token = bearer(request);
    const role = token ? roleForToken(room, await hashToken(token)) : null;
    if (path !== "/internal/ws" && !role) return fail("unauthorized", 401);
    if (path === "/internal/session" && request.method === "GET") {
      return json({ roomId: room.id, role, status: room.status, expiresAt: room.expiresAt,
        participantId: role === "host" ? room.host.id : room.guest?.id,
        peerPresent: this.connected(role === "host" ? "guest" : "host", undefined, role === "host" ? room.guest?.id : room.host.id) });
    }
    if (path === "/internal/ticket" && request.method === "POST") {
      if (!role) return fail("unauthorized", 401);
      const ticket = randomToken();
      const memberId = role === "host" ? room.host.id : room.guest!.id;
      const key = `ticket:${await hashToken(ticket)}`;
      const expiresAt = Date.now() + TICKET_MS;
      const issued = await this.ctx.storage.transaction(async (txn) => {
        const pending = await txn.list<Ticket>({ prefix: "ticket:" });
        let active = 0;
        for (const [pendingKey, value] of pending) {
          if (value.expiresAt <= Date.now()) await txn.delete(pendingKey);
          else active++;
        }
        if (active >= MAX_PENDING_TICKETS) return false;
        await txn.put(key, { role, memberId, expiresAt } satisfies Ticket);
        return true;
      });
      if (!issued) return fail("rate_limited", 429);
      return json({ ticket, expiresAt });
    }
    if (path === "/internal/leave" && request.method === "POST") {
      if (role !== "guest") return fail("forbidden", 403);
      const guestId = room.guest!.id;
      const tokenHash = await hashToken(token!);
      const released = await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<RoomRecord>("room");
        if (!latest?.guest || latest.guest.id !== guestId || latest.guest.tokenHash !== tokenHash) return null;
        const next = releaseGuest(latest, Date.now());
        if (next) await txn.put("room", next);
        return next;
      });
      if (!released) return fail("room_unavailable", 410);
      await this.scheduleAlarm(released);
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as Attachment | null;
        if (attachment?.role === "guest" && attachment.memberId === guestId) ws.close(1000, "guest-left");
      }
      this.sendTo("host", { type: "peer-left" }, released.host.id);
      return json({ status: "left" });
    }
    if (path === "/internal/close" && request.method === "POST") {
      const closed = closeRoom(room, role!);
      if (!closed) return fail("forbidden", 403);
      await this.save(closed);
      this.closeSockets("room-closed");
      return json({ status: "closed" });
    }
    if (path === "/internal/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (this.ctx.getWebSockets().length >= 8) return fail("too_many_connections", 429);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ openedAt: Date.now() } satisfies Attachment);
      await this.scheduleAlarm(room);
      return new Response(null, { status: 101, webSocket: client });
    }
    return fail("not_found", 404);
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message !== "string" || message.length > 64_000) { ws.close(1009, "invalid-message"); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(message); } catch { ws.close(1003, "invalid-json"); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { ws.close(1003, "invalid-message"); return; }
    const payload = parsed as Record<string, unknown>;
    const attachment = (ws.deserializeAttachment() ?? { openedAt: Date.now() }) as Attachment;
    const now = Date.now();
    const windowStart = attachment.windowStart && now - attachment.windowStart < SIGNAL_WINDOW_MS ? attachment.windowStart : now;
    const messageCount = windowStart === attachment.windowStart ? (attachment.messageCount ?? 0) + 1 : 1;
    if (messageCount > MAX_SIGNALS_PER_WINDOW) { ws.close(1008, "rate-limited"); return; }
    ws.serializeAttachment({ ...attachment, windowStart, messageCount } satisfies Attachment);
    const room = await this.load();
    if (!room || room.status === "closed" || room.status === "expired") { ws.close(1008, "room-unavailable"); return; }
    if (!attachment.role) {
      if (payload.type !== "auth" || !validToken(payload.ticket)) { ws.close(1008, "unauthorized"); return; }
      const key = `ticket:${await hashToken(payload.ticket)}`;
      const ticket = await this.ctx.storage.transaction(async (txn) => {
        const candidate = await txn.get<Ticket>(key);
        if (candidate) await txn.delete(key);
        return candidate;
      });
      const current = await this.load();
      const currentMemberId = ticket?.role === "host" ? current?.host.id : current?.guest?.id;
      if (!ticket || !current || ticket.expiresAt <= Date.now() || (current.status !== "active" && current.status !== "waiting")
        || !currentMemberId || ticket.memberId !== currentMemberId) {
        ws.close(1008, "invalid-ticket"); return;
      }
      for (const previous of this.ctx.getWebSockets()) {
        if (previous !== ws && (previous.deserializeAttachment() as Attachment | null)?.role === ticket.role) previous.close(4001, "replaced");
      }
      let authenticated = current;
      if (ticket.role === "guest") {
        const extended = await this.ctx.storage.transaction(async (txn) => {
          const latest = await txn.get<RoomRecord>("room");
          if (!latest?.guest || latest.guest.id !== ticket.memberId || latest.status !== "active") return null;
          const next = { ...latest, guestLeaseUntil: latest.expiresAt };
          await txn.put("room", next);
          return next;
        });
        if (!extended) { ws.close(1008, "stale-member"); return; }
        authenticated = extended;
        await this.scheduleAlarm(extended);
      }
      ws.serializeAttachment({ role: ticket.role, memberId: ticket.memberId, openedAt: attachment.openedAt,
        windowStart, messageCount } satisfies Attachment);
      ws.send(JSON.stringify({ type: "ready", role: ticket.role,
        peerPresent: this.connected(ticket.role === "host" ? "guest" : "host", undefined,
          ticket.role === "host" ? authenticated.guest?.id : authenticated.host.id), expiresAt: authenticated.expiresAt }));
      this.sendTo(ticket.role === "host" ? "guest" : "host", { type: "peer-joined" },
        ticket.role === "host" ? authenticated.guest?.id : authenticated.host.id);
      return;
    }
    const memberId = attachment.role === "host" ? room.host.id : room.guest?.id;
    if (!memberId || attachment.memberId !== memberId) { ws.close(1008, "stale-member"); return; }
    if (payload.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    const signal = parseSignal(payload, attachment.role);
    if (!signal || room.status !== "active") { ws.send(JSON.stringify({ type: "error", code: "invalid_signal" })); return; }
    this.sendTo(attachment.role === "host" ? "guest" : "host", signal,
      attachment.role === "host" ? room.guest?.id : room.host.id);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    const role = attachment?.role;
    if (!role || this.connected(role, ws, attachment.memberId)) return;
    if (role === "guest") {
      const updated = await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<RoomRecord>("room");
        if (!latest || latest.status !== "active" || !latest.guest || latest.guest.id !== attachment.memberId
          || this.connected("guest", ws, attachment.memberId)) return null;
        const next = { ...latest, guestLeaseUntil: Date.now() + GUEST_RECONNECT_MS };
        await txn.put("room", next);
        return next;
      });
      if (!updated) return;
      await this.scheduleAlarm(updated);
      this.sendTo("host", { type: "peer-left" }, updated.host.id);
      return;
    }
    const room = await this.ctx.storage.get<RoomRecord>("room");
    if (room) this.sendTo("guest", { type: "peer-left" }, room.guest?.id);
  }
  async webSocketError(ws: WebSocket): Promise<void> { ws.close(1011, "socket-error"); }

  async alarm(): Promise<void> {
    const room = await this.load();
    if (!room) return;
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.role && now - (a?.openedAt ?? now) >= 10_000) ws.close(1008, "auth-timeout");
    }
    if (room.status === "expired" || room.status === "closed") {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.scheduleAlarm(room);
  }

  private async load(): Promise<RoomRecord | null> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<RoomRecord>("room");
      if (!stored) return null;
      const current = releaseIdleGuest(stored, Date.now(), this.connected("guest", undefined, stored.guest?.id));
      if (current !== stored) await txn.put("room", current);
      return { stored, current };
    });
    if (!result) return null;
    const { stored, current } = result;
    if (current !== stored) {
      await this.scheduleAlarm(current);
      if (current.status === "expired") this.closeSockets("room-expired");
      else if (stored.guest && !current.guest) this.sendTo("host", { type: "peer-left" }, current.host.id);
    }
    return current;
  }
  private async save(room: RoomRecord): Promise<void> {
    await this.ctx.storage.put("room", room);
    await this.scheduleAlarm(room);
  }
  private async scheduleAlarm(room: RoomRecord): Promise<void> {
    const unauth = this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment() as Attachment | null)
      .filter((a) => a && !a.role).map((a) => a!.openedAt + 10_000);
    const next = room.status === "closed" || room.status === "expired" ? Date.now() + 24 * 60 * 60_000 : room.expiresAt;
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(next, ...unauth, room.guestLeaseUntil ?? next)));
  }
  private connected(role: Role, except?: WebSocket, memberId?: string): boolean {
    if (!memberId) return false;
    return this.ctx.getWebSockets().some((ws) => {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      return ws !== except && attachment?.role === role && attachment.memberId === memberId;
    });
  }
  private sendTo(role: Role, value: unknown, memberId?: string): void {
    if (!memberId) return;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.role === role && attachment.memberId === memberId) {
        try { ws.send(JSON.stringify(value)); } catch { /* peer disconnected */ }
      }
    }
  }
  private closeSockets(reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: "room-closed", reason })); ws.close(1000, reason); } catch { /* already closed */ }
    }
  }
}
