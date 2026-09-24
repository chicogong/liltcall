import { expect, test } from "@playwright/test";

const edge = "http://127.0.0.1:8787";
type Created = { roomId: string; inviteToken: string; sessionToken: string };

test("ICE credentials are STUN-only and explicitly direct-only", async ({ request }) => {
  const created = await request.post(`${edge}/v1/rooms`);
  const room = await created.json() as Created;
  const response = await request.get(`${edge}/v1/rooms/${room.roomId}/ice-servers`, {
    headers: { Authorization: `Bearer ${room.sessionToken}` },
  });
  expect(response.status()).toBe(200);
  const config = await response.json() as { policy: string; iceServers: Array<{ urls: string | string[] }> };
  expect(config.policy).toBe("direct_only");
  expect(config.iceServers.length).toBeGreaterThan(0);
  for (const server of config.iceServers) {
    for (const url of Array.isArray(server.urls) ? server.urls : [server.urls]) expect(url).toMatch(/^stun:/);
  }
});

test("room API permits one guest and rejects unauthorized or closed access", async ({ request }) => {
  const created = await request.post(`${edge}/v1/rooms`);
  expect(created.status()).toBe(201);
  const room = await created.json() as Created;
  const path = `${edge}/v1/rooms/${room.roomId}`;
  expect((await request.get(`${path}/session`)).status()).toBe(401);
  expect((await request.get(`${path}/ice-servers`)).status()).toBe(401);
  expect((await request.post(`${edge}/v1/rooms`, { headers: { Origin: "https://wrong.example" } })).status()).toBe(403);
  expect((await request.post(`${path}/join`, { data: { inviteToken: "a".repeat(32) } })).status()).toBe(403);

  const attempts = await Promise.all(Array.from({ length: 8 }, () => request.post(`${path}/join`, { data: { inviteToken: room.inviteToken } })));
  expect(attempts.map((r) => r.status()).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
  const guest = await attempts.find((r) => r.status() === 201)!.json() as { sessionToken: string };
  expect((await request.post(`${path}/close`, { headers: { Authorization: `Bearer ${guest.sessionToken}` } })).status()).toBe(403);
  expect((await request.post(`${path}/close`, { headers: { Authorization: `Bearer ${room.sessionToken}` } })).status()).toBe(200);
  expect((await request.get(`${path}/session`, { headers: { Authorization: `Bearer ${room.sessionToken}` } })).status()).toBe(410);
  expect((await request.post(`${path}/join`, { data: { inviteToken: room.inviteToken } })).status()).toBe(410);
});

test("leaving frees the guest seat and invalidates the old session and signaling ticket", async ({ request }) => {
  const created = await request.post(`${edge}/v1/rooms`);
  expect(created.status()).toBe(201);
  const room = await created.json() as Created;
  const path = `${edge}/v1/rooms/${room.roomId}`;
  const firstJoin = await request.post(`${path}/join`, { data: { inviteToken: room.inviteToken } });
  expect(firstJoin.status()).toBe(201);
  const first = await firstJoin.json() as { sessionToken: string };
  expect((await request.post(`${path}/leave`, { headers: { Authorization: `Bearer ${room.sessionToken}` } })).status()).toBe(403);
  const ticketResponse = await request.post(`${path}/ws-ticket`, { headers: { Authorization: `Bearer ${first.sessionToken}` } });
  expect(ticketResponse.status()).toBe(200);
  const { ticket } = await ticketResponse.json() as { ticket: string };

  expect((await request.post(`${path}/leave`, { headers: { Authorization: `Bearer ${first.sessionToken}` } })).status()).toBe(200);
  expect((await request.get(`${path}/session`, { headers: { Authorization: `Bearer ${first.sessionToken}` } })).status()).toBe(401);
  const secondJoin = await request.post(`${path}/join`, { data: { inviteToken: room.inviteToken } });
  expect(secondJoin.status()).toBe(201);
  const second = await secondJoin.json() as { sessionToken: string };

  const staleTicketCode = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:8787/v1/rooms/${room.roomId}/ws`);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", ticket })), { once: true });
    ws.addEventListener("close", (event) => resolve(event.code), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
  expect(staleTicketCode).toBe(1008);
  expect((await request.get(`${path}/session`, { headers: { Authorization: `Bearer ${second.sessionToken}` } })).status()).toBe(200);
  expect((await request.post(`${path}/close`, { headers: { Authorization: `Bearer ${room.sessionToken}` } })).status()).toBe(200);
});

test("an unconnected guest seat is automatically released after its reconnect window", async ({ request }) => {
  test.setTimeout(50_000);
  const created = await request.post(`${edge}/v1/rooms`);
  expect(created.status()).toBe(201);
  const room = await created.json() as Created;
  const path = `${edge}/v1/rooms/${room.roomId}`;
  const firstJoin = await request.post(`${path}/join`, { data: { inviteToken: room.inviteToken } });
  expect(firstJoin.status()).toBe(201);
  const first = await firstJoin.json() as { sessionToken: string };
  expect((await request.post(`${path}/join`, { data: { inviteToken: room.inviteToken } })).status()).toBe(409);

  await expect.poll(async () =>
    (await request.post(`${path}/join`, { data: { inviteToken: room.inviteToken } })).status(),
  { timeout: 40_000, intervals: [1000] }).toBe(201);
  expect((await request.get(`${path}/session`, {
    headers: { Authorization: `Bearer ${first.sessionToken}` },
  })).status()).toBe(401);
  expect((await request.post(`${path}/close`, {
    headers: { Authorization: `Bearer ${room.sessionToken}` },
  })).status()).toBe(200);
});

test("signaling tickets can be used only once", async ({ request }) => {
  const created = await request.post(`${edge}/v1/rooms`);
  const room = await created.json() as Created;
  const path = `${edge}/v1/rooms/${room.roomId}`;
  const ticketResponse = await request.post(`${path}/ws-ticket`, { headers: { Authorization: `Bearer ${room.sessionToken}` } });
  expect(ticketResponse.status()).toBe(200);
  const { ticket } = await ticketResponse.json() as { ticket: string };
  const url = `ws://127.0.0.1:8787/v1/rooms/${room.roomId}/ws`;

  const connect = () => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => { ws.send(JSON.stringify({ type: "auth", ticket })); resolve(ws); }, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
  const first = await connect();
  const ready = await new Promise<Record<string, unknown>>((resolve) => first.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true }));
  expect(ready.type).toBe("ready");
  const pong = new Promise<Record<string, unknown>>((resolve) => first.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true }));
  first.send(JSON.stringify({ type: "ping" }));
  expect((await pong).type).toBe("pong");
  const second = await connect();
  const closeCode = await new Promise<number>((resolve) => second.addEventListener("close", (event) => resolve(event.code), { once: true }));
  expect(closeCode).toBe(1008);
  first.close();
});

test("pending signaling tickets are bounded per room", async ({ request }) => {
  const created = await request.post(`${edge}/v1/rooms`);
  expect(created.status()).toBe(201);
  const room = await created.json() as Created;
  const path = `${edge}/v1/rooms/${room.roomId}`;
  const headers = { Authorization: `Bearer ${room.sessionToken}` };
  for (let index = 0; index < 12; index++) {
    expect((await request.post(`${path}/ws-ticket`, { headers })).status()).toBe(200);
  }
  expect((await request.post(`${path}/ws-ticket`, { headers })).status()).toBe(429);
  expect((await request.post(`${path}/close`, { headers })).status()).toBe(200);
});

test("authenticated signaling socket closes after a bounded message burst", async ({ request }) => {
  const created = await request.post(`${edge}/v1/rooms`);
  expect(created.status()).toBe(201);
  const room = await created.json() as Created;
  const path = `${edge}/v1/rooms/${room.roomId}`;
  const headers = { Authorization: `Bearer ${room.sessionToken}` };
  const ticketResponse = await request.post(`${path}/ws-ticket`, { headers });
  expect(ticketResponse.status()).toBe(200);
  const { ticket } = await ticketResponse.json() as { ticket: string };
  const closeCode = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:8787/v1/rooms/${room.roomId}/ws`);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", ticket })), { once: true });
    ws.addEventListener("message", () => {
      for (let index = 0; index < 121; index++) ws.send(JSON.stringify({ type: "ping" }));
    }, { once: true });
    ws.addEventListener("close", (event) => resolve(event.code), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
  expect(closeCode).toBe(1008);
  expect((await request.post(`${path}/close`, { headers })).status()).toBe(200);
});

test("non-object WebSocket JSON is rejected without breaking later authentication", async ({ request }) => {
  const created = await request.post(`${edge}/v1/rooms`);
  expect(created.status()).toBe(201);
  const room = await created.json() as Created;
  const url = `ws://127.0.0.1:8787/v1/rooms/${room.roomId}/ws`;
  const malformedCode = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => ws.send("null"), { once: true });
    ws.addEventListener("close", (event) => resolve(event.code), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
  expect(malformedCode).toBe(1003);

  const ticketResponse = await request.post(`${edge}/v1/rooms/${room.roomId}/ws-ticket`, {
    headers: { Authorization: `Bearer ${room.sessionToken}` },
  });
  expect(ticketResponse.status()).toBe(200);
  const { ticket } = await ticketResponse.json() as { ticket: string };
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", ticket })), { once: true });
    ws.addEventListener("message", (event) => { resolve(JSON.parse(String(event.data)) as Record<string, unknown>); ws.close(); }, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
  expect(ready.type).toBe("ready");
});
