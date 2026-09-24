import { defineConfig } from "@playwright/test";

if (process.env.LILTCALL_AI_CLOUD_TEST !== "1") {
  throw new Error("Set LILTCALL_AI_CLOUD_TEST=1 only after verifying free provider quota and billing settings");
}

export default defineConfig({
  testDir: "./tests/ai-cloud",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5187", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    {
      command: "cd apps/ai && LILTCALL_AI_MODE=cloud uv run --extra cloud uvicorn server:app --host 127.0.0.1 --port 7860 --no-access-log",
      url: "http://127.0.0.1:7860/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    { command: "npm run dev:web", url: "http://127.0.0.1:5187/ai.html", reuseExistingServer: false, timeout: 90_000 },
  ],
});
