import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";

test("Chinese browser speech reaches cloud ASR → LLM → TTS and returns WebRTC audio", async ({ request }) => {
  test.skip(process.platform !== "darwin", "This bounded smoke creates its speech fixture with macOS say.");
  test.setTimeout(120_000);
  const health = await (await request.get("/ai-api/healthz")).json();
  const streaming = process.env.LILTCALL_AI_STREAM_TEST === "1";
  expect(health.mode).toBe(streaming ? "cloud-stream-voice" : "cloud-voice");
  expect(health.active).toBe(0);

  const fixtureDir = mkdtempSync(join(tmpdir(), "liltcall-cloud-voice-"));
  const aiff = join(fixtureDir, "phrase.aiff");
  const wav = join(fixtureDir, "phrase.wav");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let page: Page | null = null;
  try {
    execFileSync("say", ["-v", "Tingting (中文（中国大陆）)", "-o", aiff, "你好，请用一句话介绍自己。"]);
    // The long silence prevents the fake microphone from repeating the request.
    execFileSync("sox", [aiff, "-r", "48000", "-c", "1", "-b", "16", wav, "pad", "0.5", "60"]);
    browser = await chromium.launch({
      headless: true,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
    });
    const context = await browser.newContext({ permissions: ["microphone"], locale: "zh-CN" });
    page = await context.newPage();
    await page.goto("/ai.html", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "和云端 AI 对话。" })).toBeVisible();
    const startedAt = Date.now();
    await page.getByRole("button", { name: "连接麦克风" }).click();
    await expect(page.locator("#ai-stage")).toHaveAttribute("data-state", /^(connected|verified)$/, { timeout: 20_000 });
    const details = page.locator("#ai-metrics");
    try {
      await expect(details).toContainText(/输入帧：[1-9]\d*/, { timeout: 30_000 });
      await expect(details).toContainText("非静音：是");
      await expect(details).toContainText(/VAD 开始\/结束：[1-9]\d*\/[1-9]\d*/, { timeout: 70_000 });
      await expect(details).toContainText(/STT 话轮：[1-9]\d*/, { timeout: 70_000 });
      await expect(details).toContainText(/LLM 文本帧：[1-9]\d*/, { timeout: 70_000 });
      await expect(details).toContainText(/TTS 音频帧：[1-9]\d*/, { timeout: 70_000 });
      await expect(details).toContainText(/收到音频包：[1-9]\d*/, { timeout: 70_000 });
      // Require a single coherent metrics snapshot, not values sampled across turns.
      await expect.poll(async () => {
        const snapshot = await details.textContent() ?? "";
        return [
          streaming
            ? /最近第 [1-9]\d* 轮：说话结束至 ASR 稳定句段 (?:\d+|—) 毫秒/
            : /最近第 [1-9]\d* 轮：ASR 请求 \d+ 毫秒/,
          /LLM 首段文本 \d+ 毫秒 \/ 完成 \d+ 毫秒/,
          streaming ? /首段文本至 TTS 首帧 PCM \d+ 毫秒/ : /首次 TTS 请求 \d+ 毫秒/,
          /LLM 开始至服务端首帧音频 \d+ 毫秒/,
          /点击至首次观察到入站 RTP \d+ 毫秒/,
        ].every((pattern) => pattern.test(snapshot));
      }, { timeout: 70_000 }).toBe(true);
    } catch (failure) {
      console.log(JSON.stringify({ result: "failed", elapsedMs: Date.now() - startedAt,
        state: await page.locator("#ai-stage").getAttribute("data-state"), counters: await details.textContent() }));
      throw failure;
    }
    await expect(page.locator("#ai-stage")).toHaveAttribute("data-state", "verified");
    await expect(page.locator("#ai-audio")).toHaveJSProperty("paused", false);
    console.log(JSON.stringify({
      result: "passed",
      clickToAllAssertionsMs: Date.now() - startedAt,
      counters: await details.textContent(),
    }));
    await page.getByRole("button", { name: "挂断" }).click();
    await expect.poll(async () => (await (await request.get("/ai-api/healthz")).json()).active).toBe(0);
    await context.close();
  } finally {
    if (page && !page.isClosed() && await page.getByRole("button", { name: "挂断" }).isEnabled().catch(() => false)) {
      await page.getByRole("button", { name: "挂断" }).click().catch(() => {});
    }
    await browser?.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
