import { expect, test } from "@playwright/test";

test("local Pipecat WebRTC probe sends microphone audio and returns a tone", async ({ page, request }) => {
  await page.goto("/ai.html");
  await expect(page.getByRole("heading", { name: "Voice path, before the AI." })).toBeVisible();
  await page.getByRole("button", { name: "Connect microphone" }).click();
  await expect(page.locator("#ai-stage")).toHaveAttribute("data-state", "verified", { timeout: 30_000 });
  await expect(page.locator("#ai-metrics")).toContainText("Non-silent input: yes");
  await expect(page.locator("#ai-metrics")).toContainText("Tone sent: yes");
  await expect(page.locator("#ai-metrics")).toContainText(/Audio packets received: [1-9]\d*/);

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("#ai-status")).toHaveText("麦克风已送达，测试音已返回");
  await page.getByRole("button", { name: "挂断" }).click();
  await expect(page.locator("#ai-stage")).toHaveAttribute("data-state", "ended");
  await expect.poll(async () => (await (await request.get("/ai-api/healthz")).json()).active).toBe(0);
  expect(await page.locator("#ai-audio").evaluate((element: HTMLAudioElement) => element.srcObject)).toBeNull();
});

test("invalid offer is rejected before allocating a connection", async ({ request }) => {
  const response = await request.post("/ai-api/api/offer", { data: { sdp: "not an offer", type: "answer" } });
  expect(response.status()).toBe(400);
  const health = await (await request.get("/ai-api/healthz")).json();
  expect(health.active).toBe(0);
});

test("loopback AI test exposes no TURN credential by default", async ({ request }) => {
  const response = await request.get("/ai-api/api/private-ice");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ iceServers: [] });
});

test("a second AI probe is refused, then can connect after the first hangs up", async ({ browser, request }) => {
  const first = await browser.newContext({ permissions: ["microphone"] });
  const second = await browser.newContext({ permissions: ["microphone"] });
  try {
    const firstPage = await first.newPage();
    const secondPage = await second.newPage();
    await firstPage.goto("/ai.html");
    await secondPage.goto("/ai.html");
    await firstPage.getByRole("button", { name: "Connect microphone" }).click();
    await expect(firstPage.locator("#ai-stage")).toHaveAttribute("data-state", "verified", { timeout: 30_000 });

    await secondPage.getByRole("button", { name: "Connect microphone" }).click();
    await expect(secondPage.locator("#ai-stage")).toHaveAttribute("data-state", "failed");
    expect((await (await request.get("/ai-api/healthz")).json()).active).toBe(1);

    await firstPage.getByRole("button", { name: "Hang up" }).click();
    await expect.poll(async () => (await (await request.get("/ai-api/healthz")).json()).active).toBe(0);
    await secondPage.getByRole("button", { name: "Connect microphone" }).click();
    await expect(secondPage.locator("#ai-stage")).toHaveAttribute("data-state", "verified", { timeout: 30_000 });
    await secondPage.getByRole("button", { name: "Hang up" }).click();
    await expect.poll(async () => (await (await request.get("/ai-api/healthz")).json()).active).toBe(0);
  } finally {
    await first.close();
    await second.close();
  }
});
