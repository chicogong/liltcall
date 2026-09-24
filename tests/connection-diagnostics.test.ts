import { describe, expect, it } from "vitest";
import { routeFromIceTransport, summarizeConnectionStats, summarizeIceChecks, type StatsEntry } from "../apps/web/src/connection-diagnostics";

const report = (id: string, type: string, extra: Record<string, unknown> = {}): StatsEntry => ({ id, type, ...extra });

describe("WebRTC connection diagnostics", () => {
  it("distinguishes unsupported ICE check statistics from an observed zero", () => {
    expect(summarizeIceChecks([])).toEqual({ candidatePairs: null, remoteCandidates: null, requestsSent: null, requestsReceived: null, responsesSent: null, responsesReceived: null });
    expect(summarizeIceChecks([
      report("pair-a", "candidate-pair", { requestsSent: 12, responsesReceived: 0 }),
      report("pair-b", "candidate-pair", { requestsSent: 3, responsesReceived: 0 }),
      report("remote-a", "remote-candidate", { candidateType: "srflx" }),
    ])).toEqual({ candidatePairs: 2, remoteCandidates: 1, requestsSent: 15, requestsReceived: null, responsesSent: null, responsesReceived: 0 });
  });
  it("uses the selected pair and detects a relay on the remote side", () => {
    const result = summarizeConnectionStats([
      report("audio", "inbound-rtp", { kind: "audio", packetsReceived: 42, packetsLost: 2, jitter: 0.0084 }),
      report("video", "inbound-rtp", { kind: "video", packetsReceived: 10, packetsLost: 1, jitter: 0.023, freezeCount: 3 }),
      report("transport", "transport", { selectedCandidatePairId: "selected" }),
      report("selected", "candidate-pair", { state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: 0.034 }),
      report("local", "local-candidate", { candidateType: "srflx" }),
      report("remote", "remote-candidate", { candidateType: "relay" }),
      report("unused", "candidate-pair", { state: "succeeded", nominated: true, localCandidateId: "local", remoteCandidateId: "other" }),
      report("other", "remote-candidate", { candidateType: "host" }),
    ]);
    expect(result).toEqual({ inboundAudioPackets: 42, inboundVideoPackets: 10, route: "relay", roundTripTimeMs: 34,
      audioPacketsReceived: 42, audioJitterMs: 8, audioPacketsLost: 2,
      videoPacketsReceived: 10, videoJitterMs: 23, videoPacketsLost: 1, videoFreezeCount: 3 });
  });

  it("reports a direct path only when both selected candidates are non-relay", () => {
    expect(summarizeConnectionStats([
      report("transport", "transport", { selectedCandidatePairId: "pair" }),
      report("pair", "candidate-pair", { state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote" }),
      report("local", "local-candidate", { candidateType: "host" }),
      report("remote", "remote-candidate", { candidateType: "srflx" }),
    ]).route).toBe("direct");
  });

  it("does not guess a route from a nominated but unselected pair", () => {
    expect(summarizeConnectionStats([
      report("audio", "inbound-rtp", { kind: "audio", packetsReceived: 10 }),
      report("pair", "candidate-pair", { state: "succeeded", nominated: true, localCandidateId: "local", remoteCandidateId: "remote" }),
      report("local", "local-candidate", { candidateType: "host" }),
      report("remote", "remote-candidate", { candidateType: "host" }),
    ])).toEqual({ inboundAudioPackets: 10, inboundVideoPackets: 0, route: "unknown", roundTripTimeMs: null,
      audioPacketsReceived: 10, audioJitterMs: null, audioPacketsLost: null,
      videoPacketsReceived: null, videoJitterMs: null, videoPacketsLost: null, videoFreezeCount: null });
  });

  it("counts incoming video separately from audio", () => {
    const result = summarizeConnectionStats([
      report("audio", "inbound-rtp", { kind: "audio", packetsReceived: 12 }),
      report("video", "inbound-rtp", { kind: "video", packetsReceived: 8 }),
    ]);
    expect(result.inboundAudioPackets).toBe(12);
    expect(result.inboundVideoPackets).toBe(8);
  });

  it("keeps unsupported or invalid quality counters unavailable instead of showing zero", () => {
    const result = summarizeConnectionStats([
      report("audio", "inbound-rtp", { kind: "audio", packetsReceived: 12, packetsLost: -1, jitter: Number.NaN }),
      report("video", "inbound-rtp", { kind: "video", packetsReceived: 0, packetsLost: 0, freezeCount: 0 }),
      report("transport", "transport", { selectedCandidatePairId: "pair" }),
      report("pair", "candidate-pair", { state: "succeeded", currentRoundTripTime: -1 }),
    ]);
    expect(result).toMatchObject({ roundTripTimeMs: null, audioJitterMs: null, audioPacketsLost: null,
      videoJitterMs: null, videoPacketsLost: null, videoFreezeCount: null });
  });

  it("shows observed zero values once RTP has arrived", () => {
    expect(summarizeConnectionStats([
      report("audio", "inbound-rtp", { kind: "audio", packetsReceived: 1, packetsLost: 0, jitter: 0 }),
      report("video", "inbound-rtp", { kind: "video", packetsReceived: 1, packetsLost: 0, jitter: 0, freezeCount: 0 }),
    ])).toMatchObject({ audioJitterMs: 0, audioPacketsLost: 0, videoJitterMs: 0, videoPacketsLost: 0, videoFreezeCount: 0 });
  });

  it("ignores an explicitly inactive inbound stream when reporting current quality", () => {
    expect(summarizeConnectionStats([
      report("old", "inbound-rtp", { kind: "audio", active: false, packetsReceived: 100, packetsLost: 9, jitter: 0.1 }),
      report("current", "inbound-rtp", { kind: "audio", active: true, packetsReceived: 4, packetsLost: 0, jitter: 0.003 }),
    ])).toMatchObject({ audioJitterMs: 3, audioPacketsLost: 0 });
  });

  it("reads only the ICE transport's actually selected pair when transport stats omit the ID", () => {
    const peer = (pair: unknown) => ({
      getReceivers: () => [{ track: { kind: "audio" }, transport: { iceTransport: { getSelectedCandidatePair: () => pair } } }],
      getSenders: () => [],
    }) as unknown as RTCPeerConnection;
    expect(routeFromIceTransport(peer({ local: { type: "srflx" }, remote: { type: "relay" } }))).toBe("relay");
    expect(routeFromIceTransport(peer({ local: { type: "host" }, remote: { type: "prflx" } }))).toBe("direct");
    expect(routeFromIceTransport(peer({ local: { candidate: "candidate:1 1 udp 1 127.0.0.1 1234 typ host" },
      remote: { candidate: "candidate:2 1 udp 1 127.0.0.1 1235 typ relay" } }))).toBe("relay");
    expect(routeFromIceTransport(peer(null))).toBe("unknown");
    expect(routeFromIceTransport(peer({ local: { type: "host" }, remote: {} }))).toBe("unknown");
  });
});
