import { defineConfig } from "@playwright/test";

const relayProduction = process.env.LILTCALL_RELAY_PRODUCTION === "1";
const localTurn = process.env.LILTCALL_RELAY_LOCAL === "1";
const localTurnSecret = "a".repeat(64); // Fixed test-only secret, never used by public TURN.

if (relayProduction && localTurn) throw new Error("Local TURN must not be used against production");

export default defineConfig({
  testDir: "./tests/e2e",
  // Public relay runs must not remove traces from a simultaneous local suite.
  outputDir: relayProduction ? "./test-results/production-relay" : "./test-results/local",
  timeout: 40_000,
  retries: 0,
  use: {
    baseURL: relayProduction ? "https://liltcall.vercel.app" : "http://127.0.0.1:5187",
    browserName: "chromium",
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    trace: relayProduction ? "off" : "retain-on-failure",
    screenshot: relayProduction ? "off" : "only-on-failure",
  },
  webServer: relayProduction ? [] : [
    { command: `npm run dev:edge:test -- --port 8787${localTurn ? ` --var COTURN_HOST:127.0.0.1 --var COTURN_AUTH_SECRET:${localTurnSecret}` : ""}`,
      url: "http://127.0.0.1:8787/healthz", reuseExistingServer: false, timeout: 90_000 },
    { command: "npm run dev:web", url: "http://127.0.0.1:5187", reuseExistingServer: false, timeout: 90_000 },
    ...(localTurn ? [{
      command: `turnserver -n --use-auth-secret --static-auth-secret=${localTurnSecret} -r liltcall-test -p 3478 -L 127.0.0.1 -E 127.0.0.1 --min-port 52300 --max-port 52340 --allow-loopback-peers --no-multicast-peers --no-tls --log-file=stdout --log-min-level=error`,
      port: 3478,
      reuseExistingServer: false,
      timeout: 30_000,
    }] : []),
  ],
});
