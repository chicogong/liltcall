import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ai",
  timeout: 45_000,
  retries: 0,
  workers: 1, // The local probe deliberately allows one peer at a time.
  use: {
    baseURL: "http://127.0.0.1:5187",
    browserName: "chromium",
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "cd apps/ai && uv run uvicorn server:app --host 127.0.0.1 --port 7860 --no-access-log",
      url: "http://127.0.0.1:7860/healthz",
      reuseExistingServer: true,
      timeout: 90_000,
    },
    {
      command: "npm run dev:web",
      url: "http://127.0.0.1:5187/ai.html",
      reuseExistingServer: true,
      timeout: 90_000,
    },
  ],
});
