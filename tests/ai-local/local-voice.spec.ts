import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";

test("Whisper → Ollama → Pocket TTS returns speech over local WebRTC", async ({ request }) => {
  test.skip(process.platform !== "darwin", "This smoke test creates its speech fixture with macOS say.");
  const health = await (await request.get("/ai-api/healthz")).json();
  expect(health.mode).toBe("local-voice");
  const fixtureDir = mkdtempSync(join(tmpdir(), "liltcall-voice-test-"));
  const aiff = join(fixtureDir, "phrase.aiff");
  const wav = join(fixtureDir, "phrase.wav");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let page: Page | null = null;
  try {
    execFileSync("say", ["-o", aiff, "Hello, how are you today? Please introduce yourself."]);
    execFileSync("sox", [aiff, "-r", "48000", "-c", "1", "-b", "16", wav, "pad", "0.5", "2"]);
    browser = await chromium.launch({
      headless: true,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
    });
    const context = await browser.newContext({ permissions: ["microphone"], locale: "en-US" });
    page = await context.newPage();
    await page.goto("/ai.html");
    await expect(page.getByRole("heading", { name: "Talk to an AI on this Mac." })).toBeVisible();
    await page.getByRole("button", { name: "Connect microphone" }).click();
    await expect(page.locator("#ai-stage")).toHaveAttribute("data-state", /^(connected|verified)$/, { timeout: 20_000 });
    await expect(page.locator("#ai-metrics")).toContainText(/Input frames: [1-9]\d*/, { timeout: 35_000 });
    await expect(page.locator("#ai-metrics")).toContainText("Non-silent: yes");
    await expect(page.locator("#ai-metrics")).toContainText(/VAD start\/stop: [1-9]\d*\/[1-9]\d*/, { timeout: 35_000 });
    await expect(page.locator("#ai-metrics")).toContainText(/STT turns: [1-9]\d*/, { timeout: 35_000 });
    await expect(page.locator("#ai-metrics")).toContainText(/LLM text frames: [1-9]\d*/, { timeout: 35_000 });
    await expect(page.locator("#ai-stage")).toHaveAttribute("data-state", "verified", { timeout: 35_000 });
    await expect(page.locator("#ai-metrics")).toContainText(/TTS audio frames: [1-9]\d*/);
    await expect(page.locator("#ai-metrics")).toContainText(/Audio packets received: [1-9]\d*/);
    await expect(page.locator("#ai-audio")).toHaveJSProperty("paused", false);
    await page.getByRole("button", { name: "Hang up" }).click();
    await expect.poll(async () => (await (await request.get("/ai-api/healthz")).json()).active).toBe(0);
    await context.close();
  } finally {
    if (page && !page.isClosed() && await page.getByRole("button", { name: "Hang up" }).isEnabled().catch(() => false)) {
      await page.getByRole("button", { name: "Hang up" }).click().catch(() => {});
    }
    await browser?.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
