import { chromium, expect } from "@playwright/test";

// Manual smoke test: creates one room on the deployed site, then closes it.
// Fake devices prove browser media flow, not real camera/mic quality or cross-network reachability.
const baseUrl = process.env.LILTCALL_BASE_URL ?? "https://liltcall.vercel.app/";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const host = await browser.newContext({ locale: "en", permissions: ["camera", "microphone"] });
const guest = await browser.newContext({ locale: "en", permissions: ["camera", "microphone"] });
const replacement = await browser.newContext({ locale: "en", permissions: ["camera", "microphone"] });
const hostPage = await host.newPage();
const guestPage = await guest.newPage();
const replacementPage = await replacement.newPage();
const failedRequests = [];
const signalingSockets = new Set();
for (const page of [hostPage, guestPage, replacementPage]) {
  page.on("requestfailed", (request) => {
    failedRequests.push({ host: new URL(request.url()).host, error: request.failure()?.errorText });
  });
  page.on("websocket", (socket) => signalingSockets.add(socket));
}

try {
  await hostPage.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 });
  await hostPage.getByRole("button", { name: "Start a call" }).click();
  const created = hostPage.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/rooms",
  );
  await hostPage.getByRole("button", { name: "Create room" }).click();
  expect((await created).status()).toBe(201);
  await expect(hostPage.locator("#invite-link")).toHaveValue(/#invite=/);
  const invite = await hostPage.locator("#invite-link").inputValue();

  await guestPage.goto(invite, { waitUntil: "networkidle", timeout: 30_000 });
  await guestPage.getByRole("button", { name: "Join this call" }).click();
  const joined = guestPage.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/join"),
  );
  await guestPage.getByRole("button", { name: "Join call" }).click();
  expect((await joined).status()).toBe(201);

  for (const page of [hostPage, guestPage]) {
    await expect(page.locator("#peer-label")).toHaveText("Connected", { timeout: 30_000 });
    await expect(page.locator("#call-detail")).toHaveAttribute("data-route", "direct", { timeout: 30_000 });
    await expect(page.locator("#call-detail")).toContainText("Receiving audio", { timeout: 30_000 });
    await expect(page.locator("#call-detail")).toContainText("Receiving video", { timeout: 30_000 });
    await expect.poll(() => page.locator("#remote-video").evaluate((video) => video.videoWidth),
      { timeout: 30_000 }).toBeGreaterThan(0);
  }
  expect(signalingSockets.size).toBeGreaterThanOrEqual(2);
  const hostVideoWidth = await hostPage.locator("#remote-video").evaluate((video) => video.videoWidth);
  const guestVideoWidth = await guestPage.locator("#remote-video").evaluate((video) => video.videoWidth);

  const left = guestPage.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/leave"),
  );
  await guestPage.getByRole("button", { name: "Leave call" }).click();
  expect((await left).status()).toBe(200);
  await expect(hostPage.locator("#peer-label")).toHaveText("Waiting to join", { timeout: 10_000 });

  await replacementPage.goto(invite, { waitUntil: "networkidle", timeout: 30_000 });
  await replacementPage.getByRole("button", { name: "Join this call" }).click();
  const rejoined = replacementPage.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/join"),
  );
  await replacementPage.getByRole("button", { name: "Join call" }).click();
  expect((await rejoined).status()).toBe(201);
  for (const page of [hostPage, replacementPage]) {
    await expect(page.locator("#peer-label")).toHaveText("Connected", { timeout: 30_000 });
    await expect(page.locator("#call-detail")).toHaveAttribute("data-route", "direct", { timeout: 30_000 });
    await expect(page.locator("#call-detail")).toContainText("Receiving audio", { timeout: 30_000 });
    await expect(page.locator("#call-detail")).toContainText("Receiving video", { timeout: 30_000 });
  }

  await hostPage.getByRole("button", { name: "End room" }).click();
  await expect(replacementPage.getByText("Call ended. You can start a new one.")).toBeVisible();
  console.log(JSON.stringify({ result: "passed", site: new URL(baseUrl).origin,
    route: "direct", initialJoin: 201, leave: 200, replacementJoin: 201,
    signalingSockets: signalingSockets.size, hostVideoWidth, guestVideoWidth }));
} catch (error) {
  const message = String(error).replace(/#invite=[^\s"']+/g, "#invite=[redacted]");
  console.error(JSON.stringify({ result: "failed", error: message.slice(0, 1200), failedRequests }));
  process.exitCode = 1;
} finally {
  if (await hostPage.locator("#app").getAttribute("data-view").catch(() => null) === "call") {
    await hostPage.getByRole("button", { name: "End room" }).click({ timeout: 3_000 }).catch(() => {});
  }
  await host.close();
  await guest.close();
  await replacement.close();
  await browser.close();
}
