import { expect, test } from "@playwright/test";
import { translate, type CopyKey, type Locale } from "../../apps/web/src/i18n";
import { stripSelectedPairId } from "./strip-selected-pair-id";

for (const locale of ["en", "zh-CN"] as const satisfies readonly Locale[]) {
const t = (key: CopyKey) => translate(locale, key);

test(`two people exchange direct audio and video, then the host closes the room (${locale})`, async ({ browser }) => {
  const host = await browser.newContext({ locale, permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"] });
  const guest = await browser.newContext({ locale, permissions: ["camera", "microphone"] });
  await guest.addInitScript(stripSelectedPairId);
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();
  try {
    await hostPage.goto("/");
    await expect(hostPage.locator("html")).toHaveAttribute("lang", locale);
    await hostPage.getByRole("button", { name: t("startCall") }).click();
    await expect(hostPage.locator("#prejoin-view")).toBeVisible();
    await hostPage.getByRole("button", { name: t("createRoom") }).click();
    await expect(hostPage.getByRole("button", { name: t("copyInviteLink") })).toBeVisible();
    await hostPage.getByRole("button", { name: t("copyInviteLink") }).click();
    const invite = await hostPage.evaluate(() => navigator.clipboard.readText());
    expect(invite).toContain("#invite=");

    await guestPage.goto(invite);
    await expect(guestPage.getByRole("button", { name: t("joinThisCall") })).toBeVisible();
    await guestPage.getByRole("button", { name: t("joinThisCall") }).click();
    await expect(guestPage.locator("#prejoin-view")).toBeVisible();
    await guestPage.getByRole("button", { name: t("joinCall") }).click();
    await expect(hostPage.locator("#peer-label")).toHaveText(t("connected"), { timeout: 20_000 });
    await expect(guestPage.locator("#peer-label")).toHaveText(t("connected"), { timeout: 20_000 });
    await expect(guestPage.locator("#call-message")).toHaveText(t("connectedMessage"));
    await expect(hostPage.locator("#invite-panel")).toBeHidden();
    await expect(hostPage.getByRole("button", { name: t("copyLink"), exact: true })).toBeVisible();
    await expect(hostPage.locator("#call-detail")).toContainText(t("receivingAudio"), { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toContainText(t("receivingAudio"), { timeout: 20_000 });
    await expect(hostPage.locator("#call-detail")).toHaveAttribute("data-route", "direct");
    await expect(guestPage.locator("#call-detail")).toHaveAttribute("data-route", "direct");
    await guestPage.locator("#call-info summary").click();
    await expect(guestPage.locator("#media-diagnostic")).toBeVisible();
    await expect(guestPage.locator("#media-diagnostic")).toContainText(locale === "en" ? "ICE RTT" : "ICE 往返");
    await expect(guestPage.locator("#media-diagnostic")).toContainText(locale === "en" ? "received" : "收到");
    await expect(guestPage.locator("#media-diagnostic")).toContainText(locale === "en" ? "ICE RTT — ms" : "ICE 往返 — 毫秒");
    await expect(guestPage.locator("#media-note")).toHaveText(t("mediaStatsNote"));
    await expect(hostPage.locator("#ice-state")).toHaveText(new RegExp(`^(?:${t("iceStateConnected")}|${t("iceStateCompleted")})$`));
    await expect(guestPage.locator("#ice-diagnostic")).toContainText(locale === "en" ? "Candidate events" : "候选事件");
    await expect(guestPage.locator("#ice-diagnostic")).toContainText(locale === "en" ? "candidate pairs" : "候选对");
    await expect.poll(async () => guestPage.locator("#ice-diagnostic").textContent()).toMatch(
      locale === "en" ? /candidate pairs [1-9]\d*, remote candidates [1-9]\d*/ : /候选对 [1-9]\d*、浏览器内对方候选 [1-9]\d*/,
    );
    expect(await hostPage.locator("#ice-diagnostic").textContent()).not.toMatch(/(?:\d{1,3}\.){3}\d{1,3}|#invite=/);
    expect(await hostPage.locator("#media-diagnostic").textContent()).not.toMatch(/(?:\d{1,3}\.){3}\d{1,3}|#invite=/);
    await expect(hostPage.locator("#call-detail")).toContainText(t("receivingVideo"), { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toContainText(t("receivingVideo"), { timeout: 20_000 });
    await expect.poll(() => hostPage.locator("#remote-video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    await expect.poll(() => guestPage.locator("#remote-video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    const hostFirstRtpMs = Number(await hostPage.locator("#call-detail").getAttribute("data-first-rtp-ms"));
    const guestFirstRtpMs = Number(await guestPage.locator("#call-detail").getAttribute("data-first-rtp-ms"));
    expect(hostFirstRtpMs).toBeGreaterThan(0);
    expect(guestFirstRtpMs).toBeGreaterThan(0);
    if (process.env.LILTCALL_PRINT_METRICS === "1") {
      console.log(`LOCAL_RTP_MS host=${hostFirstRtpMs} guest=${guestFirstRtpMs}`);
    }

    const opposite: Locale = locale === "en" ? "zh-CN" : "en";
    await hostPage.getByRole("button", { name: t(locale === "en" ? "switchToChinese" : "switchToEnglish") }).click();
    await expect(hostPage.locator("html")).toHaveAttribute("lang", opposite);
    await expect(hostPage.locator("#call-heading")).toHaveText(translate(opposite, "connectedTitle"));
    await expect(hostPage.locator("#call-detail")).toContainText(translate(opposite, "receivingAudio"));
    await expect(hostPage.locator("#media-note")).toHaveText(translate(opposite, "mediaStatsNote"));
    await hostPage.getByRole("button", { name: translate(opposite, opposite === "en" ? "switchToChinese" : "switchToEnglish") }).click();
    await expect(hostPage.locator("#call-heading")).toHaveText(t("connectedTitle"));

    await guestPage.getByRole("button", { name: t("muteMic") }).click();
    await expect(guestPage.getByRole("button", { name: t("unmuteMic") })).toHaveAttribute("aria-pressed", "true");
    await guestPage.getByRole("button", { name: t("turnCameraOff") }).click();
    await expect(guestPage.locator("#self-tile")).not.toHaveClass(/has-video/);
    await expect(hostPage.locator("#remote-tile")).not.toHaveClass(/has-video/, { timeout: 10_000 });
    await guestPage.getByRole("button", { name: t("turnCameraOn") }).click();
    await expect(hostPage.locator("#remote-tile")).toHaveClass(/has-video/, { timeout: 10_000 });
    await hostPage.getByRole("button", { name: t("endRoom") }).click();
    await expect(guestPage.getByText(t("callEnded"))).toBeVisible();
    await guestPage.goto(invite);
    await guestPage.getByRole("button", { name: t("joinThisCall") }).click();
    await guestPage.getByRole("button", { name: t("joinCall") }).click();
    await expect(guestPage.getByText(t("roomUnavailable"))).toBeVisible();
  } finally { await host.close(); await guest.close(); }
});

test(`a legacy relay query cannot enable TURN (${locale})`, async ({ browser }) => {
  const host = await browser.newContext({ locale, permissions: ["microphone", "clipboard-read", "clipboard-write"] });
  const guest = await browser.newContext({ locale, permissions: ["microphone"] });
  try {
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();
    await hostPage.goto("/?ice=relay");
    await hostPage.getByRole("button", { name: t("startCall") }).click();
    await hostPage.getByRole("button", { name: t("createRoom") }).click();
    await hostPage.getByRole("button", { name: t("copyInviteLink") }).click();
    const invite = await hostPage.evaluate(() => navigator.clipboard.readText());
    expect(invite).not.toContain("ice=relay");
    await guestPage.goto(invite);
    await guestPage.getByRole("button", { name: t("joinThisCall") }).click();
    await guestPage.getByRole("button", { name: t("joinCall") }).click();
    await expect(hostPage.locator("#call-detail")).toHaveAttribute("data-route", "direct", { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toHaveAttribute("data-route", "direct", { timeout: 20_000 });
  } finally { await host.close(); await guest.close(); }
});

test(`a guest can refresh and rejoin with the same member session (${locale})`, async ({ browser }) => {
  const host = await browser.newContext({ locale, permissions: ["microphone", "clipboard-read", "clipboard-write"] });
  const guest = await browser.newContext({ locale, permissions: ["microphone"] });
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();
  try {
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: t("startCall") }).click();
    await hostPage.getByRole("button", { name: t("createRoom") }).click();
    await hostPage.getByRole("button", { name: t("copyInviteLink") }).click();
    const invite = await hostPage.evaluate(() => navigator.clipboard.readText());
    await guestPage.goto(invite);
    await guestPage.getByRole("button", { name: t("joinThisCall") }).click();
    await guestPage.getByRole("button", { name: t("joinCall") }).click();
    await expect(guestPage.locator("#call-detail")).toContainText(t("receivingAudio"), { timeout: 20_000 });
    await guestPage.reload();
    await expect(guestPage.locator("html")).toHaveAttribute("lang", locale);
    await guestPage.getByRole("button", { name: t("rejoinThisCall") }).click();
    await guestPage.getByRole("button", { name: t("joinCall") }).click();
    await expect(hostPage.locator("#peer-label")).toHaveText(t("connected"), { timeout: 20_000 });
    await expect(guestPage.locator("#peer-label")).toHaveText(t("connected"), { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toContainText(t("receivingAudio"), { timeout: 20_000 });
  } finally { await host.close(); await guest.close(); }
});

test(`a guest can leave and use the same invite to join again (${locale})`, async ({ browser }) => {
  const host = await browser.newContext({ locale, permissions: ["camera", "microphone"] });
  const guest = await browser.newContext({ locale, permissions: ["camera", "microphone"] });
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();
  try {
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: t("startCall") }).click();
    await hostPage.getByRole("button", { name: t("createRoom") }).click();
    await expect(hostPage.locator("#invite-link")).toHaveValue(/#invite=/);
    const invite = await hostPage.locator("#invite-link").inputValue();

    await guestPage.goto(invite);
    await guestPage.getByRole("button", { name: t("joinThisCall") }).click();
    await guestPage.getByRole("button", { name: t("joinCall") }).click();
    await expect(hostPage.locator("#peer-label")).toHaveText(t("connected"), { timeout: 20_000 });
    await guestPage.getByRole("button", { name: t("leaveCall") }).click();
    await expect(guestPage.getByText(t("callEnded"))).toBeVisible();
    await expect(hostPage.locator("#peer-label")).toHaveText(t("waitingToJoin"), { timeout: 20_000 });

    await guestPage.goto(invite);
    await guestPage.getByRole("button", { name: t("joinThisCall") }).click();
    await guestPage.getByRole("button", { name: t("joinCall") }).click();
    await expect(hostPage.locator("#peer-label")).toHaveText(t("connected"), { timeout: 20_000 });
    await expect(guestPage.locator("#peer-label")).toHaveText(t("connected"), { timeout: 20_000 });
    await expect(hostPage.locator("#call-detail")).toContainText(t("receivingAudio"), { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toContainText(t("receivingAudio"), { timeout: 20_000 });
    await hostPage.getByRole("button", { name: t("endRoom") }).click();
  } finally { await host.close(); await guest.close(); }
});

test(`mobile setup can be canceled before room creation and call controls stay usable (${locale})`, async ({ browser }) => {
  const context = await browser.newContext({ locale, viewport: { width: 320, height: 568 }, permissions: ["microphone"] });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: t("startCall") }).click();
    await expect(page.locator("#prejoin-view")).toBeVisible();
    await expect(page.locator("#preview-status")).toHaveText(t("microphoneReady"));
    const setupButtonBottom = await page.getByRole("button", { name: t("createRoom") }).evaluate((button) => button.getBoundingClientRect().bottom);
    expect(setupButtonBottom).toBeLessThanOrEqual(568);
    await page.getByRole("button", { name: `← ${t("back")}` }).click();
    await expect(page.locator("#landing-view")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");

    await page.getByRole("button", { name: t("startCall") }).click();
    await page.getByRole("button", { name: t("createRoom") }).click();
    await expect(page.locator("#call-view")).toBeVisible();
    await expect(page.getByRole("button", { name: t("copyInviteLink") })).toBeVisible();
    await expect(page.getByRole("button", { name: t("endRoom") })).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      content: document.documentElement.scrollWidth,
      inviteBottom: document.querySelector("#copy-button")!.getBoundingClientRect().bottom,
      stageBottom: document.querySelector(".call-stage")!.getBoundingClientRect().bottom,
    }));
    expect(layout.content).toBe(layout.viewport);
    expect(layout.inviteBottom).toBeLessThanOrEqual(layout.stageBottom);
    await page.getByRole("button", { name: t("endRoom") }).click();
    await expect(page.locator("#landing-view")).toBeVisible();
  } finally { await context.close(); }
});

test(`host stops showing the invite prompt as soon as a guest joins (${locale})`, async ({ browser }) => {
  const host = await browser.newContext({ locale, permissions: ["microphone"] });
  const guest = await browser.newContext({ locale, permissions: ["microphone"] });
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();
  let releaseIce!: () => void;
  const iceGate = new Promise<void>((resolve) => { releaseIce = resolve; });
  try {
    await hostPage.route("**/ice-servers", async (route) => {
      await iceGate;
      await route.continue();
    });
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: t("startCall") }).click();
    await hostPage.getByRole("button", { name: t("createRoom") }).click();
    await expect(hostPage.locator("#invite-link")).toHaveValue(/#invite=/);
    await guestPage.goto(await hostPage.locator("#invite-link").inputValue());
    await guestPage.getByRole("button", { name: t("joinThisCall") }).click();
    await guestPage.getByRole("button", { name: t("joinCall") }).click();
    await expect(hostPage.locator("#call-detail")).toHaveText(t("waitingForAudio"));
    await expect(hostPage.locator("#peer-label")).toHaveText(t("peerConnecting"));
    releaseIce();
    await expect(hostPage.locator("#call-detail")).toHaveAttribute("data-route", "direct", { timeout: 20_000 });
    await hostPage.getByRole("button", { name: t("endRoom") }).click();
  } finally {
    releaseIce();
    await host.close();
    await guest.close();
  }
});
}

test("language choice survives a reload and can override browser preference", async ({ browser }) => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.getByRole("button", { name: "切换为英文" }).click();
    await expect(page.getByRole("heading", { name: "A call that stays between you two." })).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle("LiltCall — audio and video calls for two");
    await page.getByRole("button", { name: "Switch to Chinese" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  } finally { await context.close(); }
});

test("Chinese host and English guest share one audio call without sharing language settings", async ({ browser }) => {
  const host = await browser.newContext({ locale: "zh-CN", permissions: ["microphone", "clipboard-read", "clipboard-write"] });
  const guest = await browser.newContext({ locale: "en-US", permissions: ["microphone"] });
  try {
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();
    await guestPage.addInitScript(() => {
      const originalPlay = HTMLMediaElement.prototype.play;
      const tracked = window as Window & { __remotePlayAttempts?: number };
      HTMLMediaElement.prototype.play = function () {
        if (this.id === "remote-audio") {
          tracked.__remotePlayAttempts = (tracked.__remotePlayAttempts ?? 0) + 1;
          if (tracked.__remotePlayAttempts === 1) return Promise.reject(new DOMException("blocked", "NotAllowedError"));
        }
        return originalPlay.call(this);
      };
    });
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: "发起通话" }).click();
    await hostPage.getByRole("button", { name: "创建房间" }).click();
    await hostPage.getByRole("button", { name: "复制邀请链接" }).click();
    const invite = await hostPage.evaluate(() => navigator.clipboard.readText());
    await guestPage.goto(invite);
    await expect(guestPage.locator("html")).toHaveAttribute("lang", "en");
    await guestPage.getByRole("button", { name: "Join this call" }).click();
    await guestPage.getByRole("button", { name: "Join call" }).click();
    await expect(hostPage.locator("#call-detail")).toContainText("正在接收语音", { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toContainText("Receiving audio", { timeout: 20_000 });
    await expect(guestPage.locator("#notice")).toHaveText("Tap the page to enable call audio.");
    await guestPage.locator(".call-stage").click({ position: { x: 12, y: 12 } });
    await expect(guestPage.locator("#notice")).toBeEmpty();
    expect(await guestPage.evaluate(() => (window as Window & { __remotePlayAttempts?: number }).__remotePlayAttempts)).toBe(2);
    await expect(hostPage.locator("#call-detail")).toHaveAttribute("data-route", "direct");
    await expect(guestPage.locator("#call-detail")).toHaveAttribute("data-route", "direct");
    await hostPage.getByRole("button", { name: "结束房间" }).click();
  } finally { await host.close(); await guest.close(); }
});

test("microphone permission error is translated and remains retryable", async ({ browser }) => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => { throw new DOMException("blocked", "NotAllowedError"); },
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "发起通话" }).click();
    await expect(page.locator("#preview-status")).toHaveText("请在浏览器中允许使用麦克风，然后重试。");
    await expect(page.getByRole("button", { name: "重试麦克风" })).toBeVisible();
    await page.getByRole("button", { name: "切换为英文" }).click();
    await expect(page.locator("#preview-status")).toHaveText("Allow microphone access in your browser, then try again.");
    await expect(page.getByRole("button", { name: "Try microphone again" })).toBeVisible();
  } finally { await context.close(); }
});

test("camera denial keeps an audio-only room usable", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: (constraints: MediaStreamConstraints) => constraints.video
          ? Promise.reject(new DOMException("camera blocked", "NotAllowedError"))
          : capture(constraints),
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Start a call" }).click();
    await expect(page.locator("#preview-status")).toHaveText("Microphone ready. Camera unavailable; audio still works.");
    await expect(page.locator("#preview-tile")).not.toHaveClass(/has-video/);
    await page.getByRole("button", { name: "Turn camera on" }).click();
    await expect(page.locator("#notice")).toHaveText("Camera unavailable. You can continue with audio or try again.");
    await page.getByRole("button", { name: "Create room" }).click();
    await expect(page.getByRole("button", { name: "Copy invite link" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn camera on" })).toBeVisible();
    await page.getByRole("button", { name: "End room" }).click();
  } finally { await context.close(); }
});

test("one camera-off participant can still exchange audio and receive the peer video", async ({ browser }) => {
  const host = await browser.newContext({ permissions: ["microphone"] });
  const guest = await browser.newContext({ permissions: ["camera", "microphone"] });
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();
  try {
    await hostPage.addInitScript(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (constraints) => constraints?.video
        ? Promise.reject(new DOMException("camera blocked", "NotAllowedError"))
        : capture(constraints);
    });
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: "Start a call" }).click();
    await expect(hostPage.locator("#preview-status")).toHaveText("Microphone ready. Camera unavailable; audio still works.");
    await hostPage.getByRole("button", { name: "Create room" }).click();
    await expect(hostPage.locator("#invite-link")).toHaveValue(/#invite=/);
    const invite = await hostPage.locator("#invite-link").inputValue();
    await guestPage.goto(invite);
    await guestPage.getByRole("button", { name: "Join this call" }).click();
    await guestPage.getByRole("button", { name: "Join call" }).click();
    await expect(hostPage.locator("#call-detail")).toContainText("Receiving audio", { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toContainText("Receiving audio", { timeout: 20_000 });
    await expect(hostPage.locator("#call-detail")).toContainText("Receiving video", { timeout: 20_000 });
    await expect(hostPage.locator("#call-detail")).toHaveAttribute("data-route", "direct");
    await expect(guestPage.locator("#call-detail")).toHaveAttribute("data-route", "direct");
    await expect(guestPage.locator("#remote-tile")).not.toHaveClass(/has-video/);
    await hostPage.getByRole("button", { name: "End room" }).click();
  } finally { await host.close(); await guest.close(); }
});

test("a TURN URL without credentials is rejected before any media connection", async ({ browser }) => {
  const host = await browser.newContext({ permissions: ["microphone"] });
  const guest = await browser.newContext({ permissions: ["microphone"] });
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();
  try {
    await hostPage.route("**/ice-servers", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: "relay_allowed", iceServers: [{ urls: "turn:relay.example:3478" }] }),
    }));
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: "Start a call" }).click();
    await hostPage.getByRole("button", { name: "Create room" }).click();
    await expect(hostPage.locator("#invite-link")).toHaveValue(/#invite=/);
    await guestPage.goto(await hostPage.locator("#invite-link").inputValue());
    await guestPage.getByRole("button", { name: "Join this call" }).click();
    await guestPage.getByRole("button", { name: "Join call" }).click();
    await expect(hostPage.locator("#notice")).toHaveText("Could not establish a media connection, even with available relay options. Try another network.");
    await expect(hostPage.locator("#call-detail")).not.toHaveAttribute("data-route", /.+/);
    await hostPage.getByRole("button", { name: "End room" }).click();
  } finally { await host.close(); await guest.close(); }
});

test("a valid TURN-capable configuration still allows a direct call", async ({ browser }) => {
  const host = await browser.newContext({ permissions: ["microphone"] });
  const guest = await browser.newContext({ permissions: ["microphone"] });
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();
  try {
    await hostPage.route("**/ice-servers", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: "relay_allowed", iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "turn:127.0.0.1:3478?transport=udp", username: "temporary", credential: "temporary-password" },
      ] }),
    }));
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: "Start a call" }).click();
    await hostPage.getByRole("button", { name: "Create room" }).click();
    await expect(hostPage.locator("#invite-link")).toHaveValue(/#invite=/);
    await guestPage.goto(await hostPage.locator("#invite-link").inputValue());
    await guestPage.getByRole("button", { name: "Join this call" }).click();
    await guestPage.getByRole("button", { name: "Join call" }).click();
    await expect(hostPage.locator("#call-detail")).toContainText("Receiving audio", { timeout: 20_000 });
    await expect(hostPage.locator("#call-detail")).toHaveAttribute("data-route", "direct");
    await hostPage.getByRole("button", { name: "End room" }).click();
  } finally { await host.close(); await guest.close(); }
});

test("a late ICE response cannot revive a peer after the guest reloads", async ({ browser }) => {
  const host = await browser.newContext({ permissions: ["microphone", "clipboard-read", "clipboard-write"] });
  const guest = await browser.newContext({ permissions: ["microphone"] });
  let releaseFirstIce!: () => void;
  let firstRequested!: () => void;
  let secondRequested!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirstIce = resolve; });
  const firstRequest = new Promise<void>((resolve) => { firstRequested = resolve; });
  const secondRequest = new Promise<void>((resolve) => { secondRequested = resolve; });
  let iceRequests = 0;
  try {
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();
    await hostPage.route("**/ice-servers", async (route) => {
      iceRequests++;
      if (iceRequests === 1) { firstRequested(); await firstGate; }
      if (iceRequests === 2) secondRequested();
      await route.continue();
    });
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: "Start a call" }).click();
    await hostPage.getByRole("button", { name: "Create room" }).click();
    await hostPage.getByRole("button", { name: "Copy invite link" }).click();
    const invite = await hostPage.evaluate(() => navigator.clipboard.readText());
    await guestPage.goto(invite);
    await guestPage.getByRole("button", { name: "Join this call" }).click();
    await guestPage.getByRole("button", { name: "Join call" }).click();
    await firstRequest;

    await guestPage.reload();
    await expect(hostPage.locator("#peer-label")).toHaveText("Waiting to join");
    await guestPage.getByRole("button", { name: "Rejoin this call" }).click();
    await guestPage.getByRole("button", { name: "Join call" }).click();
    await secondRequest;
    releaseFirstIce();

    await expect(hostPage.locator("#call-detail")).toContainText("Receiving audio", { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toContainText("Receiving audio", { timeout: 20_000 });
    await expect(hostPage.locator("#call-detail")).toHaveAttribute("data-route", "direct");
    await hostPage.getByRole("button", { name: "End room" }).click();
  } finally {
    releaseFirstIce();
    await host.close();
    await guest.close();
  }
});

test("a dropped signaling socket can reconnect and restore bidirectional audio", async ({ browser }) => {
  const host = await browser.newContext({ permissions: ["microphone", "clipboard-read", "clipboard-write"] });
  const guest = await browser.newContext({ permissions: ["microphone"] });
  try {
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();
    await hostPage.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      const tracked = window as Window & { __sockets?: WebSocket[] };
      tracked.__sockets = [];
      window.WebSocket = new Proxy(NativeSocket, {
        construct(target, args) {
          const socket = Reflect.construct(target, args) as WebSocket;
          if (String(args[0]).includes("/v1/rooms/")) tracked.__sockets!.push(socket);
          return socket;
        },
      });
    });
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: "Start a call" }).click();
    await hostPage.getByRole("button", { name: "Create room" }).click();
    await hostPage.getByRole("button", { name: "Copy invite link" }).click();
    const invite = await hostPage.evaluate(() => navigator.clipboard.readText());
    await guestPage.goto(invite);
    await guestPage.getByRole("button", { name: "Join this call" }).click();
    await guestPage.getByRole("button", { name: "Join call" }).click();
    await expect(hostPage.locator("#call-detail")).toContainText("Receiving audio", { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toContainText("Receiving audio", { timeout: 20_000 });
    await expect(hostPage.locator("#signal-state")).toHaveText("SIGNAL READY");
    await expect(guestPage.locator("#signal-state")).toHaveText("SIGNAL READY");

    await expect.poll(() => hostPage.evaluate(() => (window as Window & { __sockets?: WebSocket[] }).__sockets?.length)).toBe(1);
    await hostPage.evaluate(() => (window as Window & { __sockets?: WebSocket[] }).__sockets?.at(-1)?.close(4000, "test-drop"));
    await expect.poll(() => hostPage.evaluate(() => (window as Window & { __sockets?: WebSocket[] }).__sockets?.length), { timeout: 10_000 }).toBeGreaterThan(1);
    await expect(hostPage.locator("#call-detail")).toContainText("Receiving audio", { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toContainText("Receiving audio", { timeout: 20_000 });
    await expect(hostPage.locator("#signal-state")).toHaveText("SIGNAL READY");
    await expect(guestPage.locator("#signal-state")).toHaveText("SIGNAL READY");
    await expect(hostPage.locator("#peer-label")).toHaveText("Connected");
    await hostPage.getByRole("button", { name: "End room" }).click();
  } finally { await host.close(); await guest.close(); }
});

test("an offer lost when signaling drops is regenerated after reconnect", async ({ browser }) => {
  const host = await browser.newContext({ permissions: ["microphone"] });
  const guest = await browser.newContext({ permissions: ["microphone"] });
  try {
    const hostPage = await host.newPage();
    const guestPage = await guest.newPage();
    await hostPage.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      const state = window as Window & { __droppedFirstOffer?: boolean };
      state.__droppedFirstOffer = false;
      window.WebSocket = new Proxy(NativeSocket, {
        construct(target, args) {
          const ws = Reflect.construct(target, args) as WebSocket;
          const originalSend = ws.send.bind(ws);
          ws.send = (data) => {
            if (!state.__droppedFirstOffer && typeof data === "string" && JSON.parse(data).type === "offer") {
              state.__droppedFirstOffer = true;
              ws.close(4000, "test-offer-drop");
              return;
            }
            originalSend(data);
          };
          return ws;
        },
      });
    });
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: "Start a call" }).click();
    await hostPage.getByRole("button", { name: "Create room" }).click();
    await expect(hostPage.locator("#invite-link")).toHaveValue(/#invite=/);
    const invite = await hostPage.locator("#invite-link").inputValue();
    await guestPage.goto(invite);
    await guestPage.getByRole("button", { name: "Join this call" }).click();
    await guestPage.getByRole("button", { name: "Join call" }).click();
    await expect.poll(() => hostPage.evaluate(() => (window as Window & { __droppedFirstOffer?: boolean }).__droppedFirstOffer)).toBe(true);
    await expect(hostPage.locator("#call-detail")).toHaveAttribute("data-route", "direct", { timeout: 20_000 });
    await expect(guestPage.locator("#call-detail")).toHaveAttribute("data-route", "direct", { timeout: 20_000 });
    await hostPage.getByRole("button", { name: "End room" }).click();
  } finally { await host.close(); await guest.close(); }
});

test("blocked browser storage does not prevent creating or ending a call", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.addInitScript(() => {
      for (const method of ["getItem", "setItem", "removeItem"] as const) {
        Object.defineProperty(Storage.prototype, method, {
          configurable: true,
          value: () => { throw new DOMException("storage blocked", "SecurityError"); },
        });
      }
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Switch to Chinese" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.getByRole("button", { name: "发起通话" }).click();
    await page.getByRole("button", { name: "创建房间" }).click();
    await expect(page.getByRole("button", { name: "复制邀请链接" })).toBeVisible();
    await page.getByRole("button", { name: "结束房间" }).click();
    await expect(page.locator("#landing-view")).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); }
});

test("a missing level meter does not block microphone setup", async ({ browser }) => {
  const context = await browser.newContext({ locale: "zh-CN", permissions: ["microphone"] });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      Object.defineProperty(window, "AudioContext", { configurable: true, value: function () { throw new Error("meter unavailable"); } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "发起通话" }).click();
    await expect(page.locator("#preview-status")).toHaveText("麦克风已就绪。音量显示不可用，但可以继续通话。");
    await page.getByRole("button", { name: "创建房间" }).click();
    await expect(page.getByRole("button", { name: "复制邀请链接" })).toBeVisible();
    await page.getByRole("button", { name: "结束房间" }).click();
  } finally { await context.close(); }
});
