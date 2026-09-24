import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const baseURL = "http://127.0.0.1:5187";
const outputDir = resolve("docs/screenshots");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

async function installSampleCamera(page, variant) {
  await page.addInitScript((name) => {
    const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let sampleTrack;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!constraints.video) return nativeCapture(constraints);
      const media = constraints.audio ? await nativeCapture({ audio: constraints.audio, video: false }) : new MediaStream();
      if (!sampleTrack || sampleTrack.readyState !== "live") {
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext("2d");
        const warm = name === "host";
        const draw = (time) => {
          const backdrop = ctx.createLinearGradient(0, 0, 1280, 720);
          backdrop.addColorStop(0, warm ? "#314b5f" : "#2e425e");
          backdrop.addColorStop(1, warm ? "#688a87" : "#6d7eae");
          ctx.fillStyle = backdrop;
          ctx.fillRect(0, 0, 1280, 720);
          ctx.fillStyle = warm ? "#d7e9d5" : "#cbd9f1";
          ctx.beginPath();
          ctx.arc(890, 250, 205, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = warm ? "#182d40" : "#273956";
          ctx.beginPath();
          ctx.moveTo(0, 720);
          ctx.lineTo(0, 460);
          ctx.quadraticCurveTo(370, 195, 760, 720);
          ctx.fill();
          ctx.fillStyle = warm ? "#f1d5b0" : "#e0c0ae";
          ctx.beginPath();
          ctx.arc(485, 350, 155, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = warm ? "#172738" : "#263146";
          ctx.beginPath();
          ctx.arc(465, 278, 158, Math.PI, 2 * Math.PI);
          ctx.lineTo(620, 316);
          ctx.quadraticCurveTo(470, 260, 315, 336);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,.34)";
          ctx.beginPath();
          ctx.arc(1080 + Math.sin(time / 1200) * 16, 585, 35, 0, Math.PI * 2);
          ctx.fill();
          requestAnimationFrame(draw);
        };
        requestAnimationFrame(draw);
        sampleTrack = canvas.captureStream(15).getVideoTracks()[0];
      }
      media.addTrack(sampleTrack);
      return media;
    };
  }, variant);
}

async function captureLocale(locale, suffix, labels) {
  const options = { locale, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, permissions: ["microphone", "camera"] };
  const host = await browser.newContext(options);
  const guest = await browser.newContext(options);
  try {
    const hostPage = await host.newPage();
    await installSampleCamera(hostPage, "host");
    await hostPage.goto(baseURL);
    await hostPage.waitForLoadState("networkidle");
    await hostPage.getByRole("button", { name: labels.start }).waitFor();
    await hostPage.screenshot({ path: resolve(outputDir, `landing${suffix}.png`), fullPage: true });

    await hostPage.getByRole("button", { name: labels.start }).click();
    await hostPage.waitForFunction(() => document.querySelector("#preview-status")?.getAttribute("data-i18n") === "microphoneReady");
    await hostPage.waitForFunction(() => (document.querySelector("#preview-video")?.videoWidth ?? 0) > 0);
    await hostPage.screenshot({ path: resolve(outputDir, `prejoin${suffix}.png`), fullPage: true });
    await hostPage.setViewportSize({ width: 320, height: 568 });
    await hostPage.screenshot({ path: resolve(outputDir, `mobile-prejoin${suffix}.png`) });
    await hostPage.setViewportSize({ width: 1440, height: 900 });
    await hostPage.getByRole("button", { name: labels.create }).click();
    await hostPage.locator("#invite-link").waitFor({ state: "visible" });
    await hostPage.screenshot({ path: resolve(outputDir, `waiting${suffix}.png`), fullPage: true });
    await hostPage.setViewportSize({ width: 320, height: 568 });
    await hostPage.screenshot({ path: resolve(outputDir, `mobile-waiting${suffix}.png`) });
    await hostPage.setViewportSize({ width: 1440, height: 900 });
    const invite = await hostPage.locator("#invite-link").inputValue();
    if (!invite.includes("#invite=")) throw new Error("Invitation was not created");

    const guestPage = await guest.newPage();
    await installSampleCamera(guestPage, "guest");
    await guestPage.goto(invite);
    await guestPage.waitForLoadState("networkidle");
    await guestPage.getByRole("button", { name: labels.joinInvite }).click();
    await guestPage.getByRole("button", { name: labels.join }).click();
    await guestPage.waitForFunction(() => document.querySelector("#call-detail")?.getAttribute("data-route") === "direct" && (document.querySelector("#remote-video")?.videoWidth ?? 0) > 0, undefined, { timeout: 20_000 });
    await guestPage.screenshot({ path: resolve(outputDir, `local-call${suffix}.png`), fullPage: true });

    await hostPage.getByRole("button", { name: labels.end }).click();
    console.log(`Captured ${locale}: landing, prejoin, waiting, local-call, and two mobile states (synthetic camera art, fake microphone, local direct P2P)`);
  } finally {
    await host.close();
    await guest.close();
  }
}

try {
  await captureLocale("en", "", { start: "Start a call", create: "Create room", joinInvite: "Join this call", join: "Join call", end: "End room" });
  await captureLocale("zh-CN", "-zh", { start: "发起通话", create: "创建房间", joinInvite: "加入通话", join: "加入通话", end: "结束房间" });
} finally { await browser.close(); }
