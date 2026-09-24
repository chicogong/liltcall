import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ai-local",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5187", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    { command: "OLLAMA_NO_CLOUD=1 OLLAMA_NOHISTORY=1 ollama serve", url: "http://127.0.0.1:11434/api/tags", reuseExistingServer: true, timeout: 90_000 },
    { command: "cd apps/ai && LILTCALL_AI_MODE=local uv run --extra local uvicorn server:app --host 127.0.0.1 --port 7860 --no-access-log", url: "http://127.0.0.1:7860/healthz", reuseExistingServer: true, timeout: 120_000 },
    { command: "npm run dev:web", url: "http://127.0.0.1:5187/ai.html", reuseExistingServer: true, timeout: 90_000 },
  ],
});
