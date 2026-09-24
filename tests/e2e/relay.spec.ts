import { expect, test, type Page } from "@playwright/test";
import { stripSelectedPairId } from "./strip-selected-pair-id";

test("real TURN relay carries bidirectional audio and video", async ({ browser }) => {
  const localTurn = process.env.LILTCALL_RELAY_LOCAL === "1";
  const tcpOnly = process.env.LILTCALL_RELAY_TCP_ONLY === "1";
  test.skip(process.env.LILTCALL_RELAY_TEST !== "1" && !localTurn, "Requires a TURN server: use test:relay:local, test:relay, or test:relay:production");
  const host = await browser.newContext({ permissions: ["microphone", "camera"] });
  const guest = await browser.newContext({ permissions: ["microphone", "camera"] });
  await guest.addInitScript(stripSelectedPairId);
  let hostPage: Page | undefined;
  try {
    for (const context of [host, guest]) {
      if (tcpOnly) {
        await context.route("**/v1/rooms/*/ice-servers", async (route) => {
          const response = await route.fetch();
          if (!response.ok()) return route.fulfill({ response });
          const ice = await response.json() as { iceServers: RTCIceServer[]; policy: string; expiresAt?: number };
          const relay = ice.iceServers.find((server) => (Array.isArray(server.urls) ? server.urls : [server.urls])
            .some((url) => typeof url === "string" && url.startsWith("turn:")));
          const tcpUrls = (Array.isArray(relay?.urls) ? relay.urls : [relay?.urls])
            .filter((url): url is string => typeof url === "string" && url.includes("?transport=tcp"));
          if (!relay?.username || !relay.credential || !tcpUrls.length) throw new Error("TURN TCP URL missing");
          await route.fulfill({ response, json: { ...ice, iceServers: [{ urls: tcpUrls, username: relay.username, credential: relay.credential }] } });
        });
      }
      await context.addInitScript(() => {
        const BrowserPeerConnection = globalThis.RTCPeerConnection;
        Object.defineProperty(globalThis, "RTCPeerConnection", {
          configurable: true,
          value: class RelayOnlyPeerConnection extends BrowserPeerConnection {
            constructor(config?: RTCConfiguration) { super({ ...config, iceTransportPolicy: "relay" }); }
          },
        });
      });
    }
    hostPage = await host.newPage();
    const guestPage = await guest.newPage();
    await hostPage.goto("/");
    await hostPage.getByRole("button", { name: "Start a call" }).click();
    await hostPage.getByRole("button", { name: "Create room" }).click();
    await expect(hostPage.locator("#invite-link")).toHaveValue(/#invite=/);
    await guestPage.goto(await hostPage.locator("#invite-link").inputValue());
    await guestPage.getByRole("button", { name: "Join this call" }).click();
    await guestPage.getByRole("button", { name: "Join call" }).click();
    for (const page of [hostPage, guestPage]) {
      await expect(page.locator("#call-detail")).toHaveAttribute("data-route", "relay", { timeout: 30_000 });
      await expect(page.locator("#call-detail")).toContainText("Receiving audio");
      await expect(page.locator("#call-detail")).toContainText("Receiving video");
      await page.locator("#call-info summary").click();
      await expect(page.locator("#media-diagnostic")).toBeVisible();
      await expect(page.locator("#media-diagnostic")).toContainText("ICE RTT");
      if (page === guestPage) await expect(page.locator("#media-diagnostic")).toContainText("ICE RTT — ms");
      await expect.poll(() => page.locator("#remote-video").evaluate((video: HTMLVideoElement) => video.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0);
    }
    await hostPage.getByRole("button", { name: "End room" }).click();
  } finally {
    if (hostPage && await hostPage.locator("#app").getAttribute("data-view").catch(() => null) === "call") {
      await hostPage.getByRole("button", { name: "End room" }).click({ timeout: 3000 }).catch(() => {});
    }
    await host.close();
    await guest.close();
  }
});
