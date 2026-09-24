import { defineConfig } from "@playwright/test";

if (process.env.LILTCALL_AI_PRIVATE_TEST !== "1") {
  throw new Error("Set LILTCALL_AI_PRIVATE_TEST=1 only for a loopback-tunneled private AI probe");
}
if (process.env.LILTCALL_AI_PROXY_TARGET !== "http://127.0.0.1:17860") {
  throw new Error("Private test requires the local SSH tunnel on 127.0.0.1:17860");
}

export default defineConfig({
  testDir: "./tests/ai-private",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5187",
    browserName: "chromium",
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    trace: "off", // TURN credentials appear in signaling responses.
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev:web",
    url: "http://127.0.0.1:5187/ai.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
