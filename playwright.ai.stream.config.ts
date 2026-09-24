import { defineConfig } from "@playwright/test";

if (process.env.LILTCALL_AI_STREAM_TEST !== "1"
  || process.env.LILTCALL_AI_CLOUD_ALLOW_BILLING !== "1"
  || process.env.LILTCALL_AI_REALTIME_ALLOW_BILLING !== "1") {
  throw new Error("Realtime cloud browser test requires all three explicit opt-ins after quota and billing review");
}
if (!/^\d{6,12}$/.test(process.env.TENCENTCLOUD_APP_ID ?? "")) {
  throw new Error("Realtime cloud browser test requires the account AppID");
}

export default defineConfig({
  testDir: "./tests/ai-cloud",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5187", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    {
      command: "cd apps/ai && LILTCALL_AI_MODE=cloud-stream uv run --extra cloud uvicorn server:app --host 127.0.0.1 --port 7860 --no-access-log",
      url: "http://127.0.0.1:7860/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    { command: "npm run dev:web", url: "http://127.0.0.1:5187/ai.html", reuseExistingServer: false, timeout: 90_000 },
  ],
});
