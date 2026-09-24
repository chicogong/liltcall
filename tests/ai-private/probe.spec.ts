import { expect, test } from "@playwright/test";

test("Mac browser reaches private remote AI over WebRTC and receives audio", async ({ page, request }) => {
  const health = await (await request.get("/ai-api/healthz")).json();
  expect(health.mode).toBe("audio-probe");
  expect(health.active).toBe(0);
  let answerCandidates: Record<string, number> | null = null;
  page.on("response", async (response) => {
    if (!response.url().endsWith("/ai-api/api/offer") || response.request().method() !== "POST" || !response.ok()) return;
    const answer = await response.json() as { sdp: string };
    answerCandidates = Object.fromEntries(["host", "srflx", "relay"].map((type) =>
      [type, (answer.sdp.match(new RegExp(`a=candidate:.* typ ${type}(?: |\\r|\\n)`, "g")) ?? []).length]));
  });
  await page.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    (window as unknown as { __privateAiEvents: { candidates: string[]; errors: number } }).__privateAiEvents = { candidates: [], errors: 0 };
    window.RTCPeerConnection = new Proxy(NativePeer, {
      construct(target, args) {
        const pc = Reflect.construct(target, args) as RTCPeerConnection;
        (window as unknown as { __privateAiPeer?: RTCPeerConnection }).__privateAiPeer = pc;
        pc.addEventListener("icecandidate", (event) => {
          if (event.candidate) {
            const type = / typ (host|srflx|relay)(?: |$)/.exec(event.candidate.candidate)?.[1] ?? "other";
            (window as unknown as { __privateAiEvents: { candidates: string[] } }).__privateAiEvents.candidates.push(type);
          }
        });
        pc.addEventListener("icecandidateerror", () => {
          (window as unknown as { __privateAiEvents: { errors: number } }).__privateAiEvents.errors++;
        });
        return pc;
      },
    });
  });
  await page.goto("/ai.html");
  await expect(page.getByRole("heading", { name: "Voice path, before the AI." })).toBeVisible();
  const startedAt = Date.now();
  await page.getByRole("button", { name: "Connect microphone" }).click();
  try {
    await expect(page.locator("#ai-stage")).toHaveAttribute("data-state", "verified", { timeout: 40_000 });
    await expect(page.locator("#ai-metrics")).toContainText("Non-silent input: yes");
    await expect(page.locator("#ai-metrics")).toContainText("Tone sent: yes");
    await expect(page.locator("#ai-metrics")).toContainText(/Audio packets received: [1-9]\d*/);
    const selected = await page.evaluate(async () => {
      const pc = (window as unknown as { __privateAiPeer?: RTCPeerConnection }).__privateAiPeer;
      if (!pc) return null;
      const stats = await pc.getStats();
      const transport = [...stats.values()].find((item) => item.type === "transport");
      const pair = transport?.selectedCandidatePairId ? stats.get(transport.selectedCandidatePairId) : null;
      const local = pair?.localCandidateId ? stats.get(pair.localCandidateId) : null;
      const remote = pair?.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null;
      return { localType: local?.candidateType, remoteType: remote?.candidateType, state: pc.iceConnectionState };
    });
    expect(selected?.state).toBe("connected");
    console.log(JSON.stringify({ result: "passed", firstAudioObservedMs: Date.now() - startedAt, selectedCandidateTypes: selected }));
  } catch (failure) {
    const diagnostic = await page.evaluate(async () => {
      const pc = (window as unknown as { __privateAiPeer?: RTCPeerConnection }).__privateAiPeer;
      if (!pc) return { peer: false };
      const stats = await pc.getStats();
      return {
        state: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        events: (window as unknown as { __privateAiEvents?: { candidates: string[]; errors: number } }).__privateAiEvents,
        localTypes: [...stats.values()].filter((item) => item.type === "local-candidate").map((item) => item.candidateType),
        remoteTypes: [...stats.values()].filter((item) => item.type === "remote-candidate").map((item) => item.candidateType),
        pairStates: [...stats.values()].filter((item) => item.type === "candidate-pair").map((item) => item.state),
        ui: document.querySelector("#ai-stage")?.getAttribute("data-state"),
        metrics: document.querySelector("#ai-metrics")?.textContent,
      };
    }).catch(() => ({ diagnosticUnavailable: true }));
    console.log(JSON.stringify({ result: "failed", answerCandidates, diagnostic }));
    throw failure;
  } finally {
    await page.getByRole("button", { name: "Hang up" }).click().catch(() => {});
    await expect.poll(async () => (await (await request.get("/ai-api/healthz")).json()).active).toBe(0);
  }
});
