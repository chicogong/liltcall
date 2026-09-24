import { chromium, devices, expect, test } from "@playwright/test";

test.use({ browserName: "webkit", launchOptions: {} });
const site = process.env.LILTCALL_BASE_URL ?? "http://127.0.0.1:5187";

for (const locale of ["en", "zh-CN"] as const) {
  test(`Chromium host and WebKit guest direct call (${locale})`, async ({ browser }) => {
    const chromiumBrowser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
    const host = await chromiumBrowser.newContext({ locale, baseURL: site, permissions: ["camera", "microphone"] });
    const guest = await browser.newContext({ ...devices["iPhone 13"], locale, permissions: ["camera", "microphone"] });
    try {
      const hostPage = await host.newPage();
      const guestPage = await guest.newPage();
      for (const page of [hostPage, guestPage]) {
        await page.addInitScript(() => {
          const NativePeer = window.RTCPeerConnection;
          const tracked = window as Window & { __testPeer?: RTCPeerConnection };
          window.RTCPeerConnection = new Proxy(NativePeer, {
            construct(target, args) {
              const pc = Reflect.construct(target, args) as RTCPeerConnection;
              tracked.__testPeer = pc;
              return pc;
            },
          });
        });
      }
      await hostPage.goto("/");
      await hostPage.getByRole("button", { name: locale === "en" ? "Start a call" : "发起通话" }).click();
      await hostPage.getByRole("button", { name: locale === "en" ? "Create room" : "创建房间" }).click();
      await expect(hostPage.locator("#invite-link")).toHaveValue(/#invite=/);
      const invite = await hostPage.locator("#invite-link").inputValue();
      await guestPage.goto(invite);
      await guestPage.getByRole("button", { name: locale === "en" ? "Join this call" : "加入通话" }).click();
      await guestPage.getByRole("button", { name: locale === "en" ? "Join call" : "加入通话" }).click();
      const diagnostic = async (page: typeof hostPage) => page.evaluate(async () => ({
        signal: document.querySelector("#signal-state")?.textContent,
        ice: document.querySelector("#ice-state")?.textContent,
        detail: document.querySelector("#ice-diagnostic")?.textContent,
        notice: document.querySelector("#notice")?.textContent,
        status: document.querySelector("#call-status")?.textContent,
        peer: await (async () => {
          const pc = (window as Window & { __testPeer?: RTCPeerConnection }).__testPeer;
          if (!pc) return null;
          const pairs: Array<{ state: string; nominated: boolean; requests: number; responses: number }> = [];
          (await pc.getStats()).forEach((report) => {
            if (report.type === "candidate-pair") pairs.push({ state: report.state, nominated: !!report.nominated, requests: report.requestsSent ?? 0, responses: report.responsesReceived ?? 0 });
          });
          return { connection: pc.connectionState, signaling: pc.signalingState, local: !!pc.localDescription, remote: !!pc.remoteDescription, pairs };
        })(),
      }));
      try {
        await expect(hostPage.locator("#call-detail")).toHaveAttribute("data-route", "direct", { timeout: 25_000 });
        await expect(guestPage.locator("#call-detail")).toHaveAttribute("data-route", "direct", { timeout: 25_000 });
      } catch (error) {
        console.log("WEBKIT_ICE_DIAGNOSTIC", JSON.stringify({ host: await diagnostic(hostPage), guest: await diagnostic(guestPage) }));
        throw error;
      }
      await expect(hostPage.locator("#call-detail")).toContainText(locale === "en" ? "Receiving video" : "正在接收视频");
      await expect(guestPage.locator("#call-detail")).toContainText(locale === "en" ? "Receiving video" : "正在接收视频");
      await guestPage.locator("#call-info summary").click();
      await expect(guestPage.locator("#media-diagnostic")).toBeVisible();
      await expect(guestPage.locator("#media-diagnostic")).toContainText(locale === "en" ? "ICE RTT" : "ICE 往返");
      await hostPage.getByRole("button", { name: locale === "en" ? "End room" : "结束房间" }).click();
    } finally { await host.close(); await guest.close(); await chromiumBrowser.close(); }
  });
}
