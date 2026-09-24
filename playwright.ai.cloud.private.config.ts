import { defineConfig } from "@playwright/test";

if (process.env.LILTCALL_AI_CLOUD_TEST !== "1" || process.env.LILTCALL_AI_PRIVATE_TEST !== "1") {
  throw new Error("Private cloud test requires explicit cloud-billing and private-test opt-ins");
}
if (process.env.LILTCALL_AI_PROXY_TARGET !== "http://127.0.0.1:17860") {
  throw new Error("Private cloud test requires the local SSH tunnel on 127.0.0.1:17860");
}

export default defineConfig({
  testDir: "./tests/ai-cloud",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5187", trace: "off", screenshot: "only-on-failure" },
  webServer: {
    command: "npm run dev:web",
    url: "http://127.0.0.1:5187/ai.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
