// Manual, one-room cross-network ICE probe. Uses Chrome fake media, not the real microphone.
// Example: LILTCALL_SITE=https://liltcall.vercel.app node tests/manual-live-host.mjs
import { chromium } from "@playwright/test";

const site = process.env.LILTCALL_SITE;
if (!site || !/^https:\/\//.test(site)) throw new Error("Set LILTCALL_SITE to the HTTPS test site");

const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ locale: "zh-CN", permissions: ["camera", "microphone"] });
const page = await context.newPage();
let created = false;
try {
  await page.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    const target = window;
    window.RTCPeerConnection = new Proxy(NativePeer, {
      construct(ctor, args) {
        const pc = Reflect.construct(ctor, args);
        target.__liltcallDiagnosticPeer = pc;
        return pc;
      },
    });
  });
  await page.goto(site, { waitUntil: "networkidle" });
  await page.locator("#create-button").click();
  await page.locator("#enter-button").click();
  await page.locator("#invite-link").waitFor({ state: "visible" });
  const invite = await page.locator("#invite-link").inputValue();
  if (!invite.includes("#invite=")) throw new Error("Invite link was not created");
  created = true;
  console.log(`INVITE ${invite}`);

  const stopAt = Date.now() + 8 * 60_000;
  let last = "";
  let guestSeen = false;
  let terminalSince = null;
  while (Date.now() < stopAt) {
    const report = await page.evaluate(async () => {
      const pc = window.__liltcallDiagnosticPeer;
      const pairs = { total: 0, inProgress: 0, succeeded: 0, failed: 0 };
      const checks = { sent: 0, received: 0, repliesSent: 0, repliesReceived: 0 };
      const candidates = { local: {}, remote: {} };
      if (pc) {
        (await pc.getStats()).forEach((item) => {
          if (item.type === "candidate-pair") {
            ++pairs.total;
            if (item.state === "in-progress") ++pairs.inProgress;
            if (item.state === "succeeded") ++pairs.succeeded;
            if (item.state === "failed") ++pairs.failed;
            checks.sent += item.requestsSent ?? 0;
            checks.received += item.requestsReceived ?? 0;
            checks.repliesSent += item.responsesSent ?? 0;
            checks.repliesReceived += item.responsesReceived ?? 0;
          } else if (item.type === "local-candidate" || item.type === "remote-candidate") {
            const group = item.type === "local-candidate" ? candidates.local : candidates.remote;
            const kind = String(item.candidateType ?? "unknown");
            group[kind] = (group[kind] ?? 0) + 1;
          }
        });
      }
      return {
        presence: document.querySelector("#call-view")?.getAttribute("data-peer"),
        signal: document.querySelector("#signal-state")?.textContent,
        ice: pc?.iceConnectionState ?? "none",
        connection: pc?.connectionState ?? "none",
        localDescription: !!pc?.localDescription,
        remoteDescription: !!pc?.remoteDescription,
        candidates, pairs, checks,
        route: document.querySelector("#call-detail")?.getAttribute("data-route"),
      };
    });
    const normalized = JSON.stringify(report);
    if (normalized !== last) {
      console.log(`STATUS ${normalized}`);
      last = normalized;
    }
    if (report.presence !== "waiting") guestSeen = true;
    if (guestSeen && (report.presence === "connected" || report.presence === "failed")) {
      terminalSince ??= Date.now();
      // Leave enough time to capture the guest-side connection details after failure.
      if (Date.now() - terminalSince > 2 * 60_000) break;
    }
    await page.waitForTimeout(3000);
  }
} finally {
  if (created) {
    try { await page.locator("#end-button").click({ timeout: 3000 }); } catch { /* Room also expires. */ }
  }
  await context.close();
  await browser.close();
}
