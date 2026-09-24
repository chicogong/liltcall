export type StatsEntry = { id: string; type: string; [key: string]: unknown };
export type MediaRoute = "direct" | "relay" | "unknown";

export type ConnectionDiagnostics = {
  inboundAudioPackets: number;
  inboundVideoPackets: number;
  route: MediaRoute;
  roundTripTimeMs: number | null;
  audioPacketsReceived: number | null;
  audioJitterMs: number | null;
  audioPacketsLost: number | null;
  videoPacketsReceived: number | null;
  videoJitterMs: number | null;
  videoPacketsLost: number | null;
  videoFreezeCount: number | null;
};

function routeForCandidateTypes(localType: unknown, remoteType: unknown): MediaRoute {
  if (localType === "relay" || remoteType === "relay") return "relay";
  const directTypes = new Set(["host", "srflx", "prflx"]);
  return directTypes.has(localType as string) && directTypes.has(remoteType as string) ? "direct" : "unknown";
}

function selectedCandidateType(candidate: RTCIceCandidate | undefined): string | null {
  if (!candidate) return null;
  if (typeof candidate.type === "string") return candidate.type;
  return typeof candidate.candidate === "string"
    ? /\btyp (host|srflx|prflx|relay)\b/i.exec(candidate.candidate)?.[1]?.toLowerCase() ?? null
    : null;
}

/** Read the browser's actual selected pair when stats omit its ID; never infer selection from nomination. */
export function routeFromIceTransport(pc: Pick<RTCPeerConnection, "getReceivers" | "getSenders">): MediaRoute {
  const receivers = pc.getReceivers();
  const senders = pc.getSenders();
  const media = [
    ...receivers.filter((receiver) => receiver.track?.kind === "audio"),
    ...senders.filter((sender) => sender.track?.kind === "audio"),
    ...receivers,
    ...senders,
  ];
  for (const endpoint of media) {
    const transport = endpoint.transport?.iceTransport;
    if (!transport || typeof transport.getSelectedCandidatePair !== "function") continue;
    try {
      const pair = transport.getSelectedCandidatePair();
      if (!pair) continue;
      const route = routeForCandidateTypes(selectedCandidateType(pair.local), selectedCandidateType(pair.remote));
      if (route !== "unknown") return route;
    } catch { /* An unsupported or closing transport does not justify guessing the route. */ }
  }
  return "unknown";
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function activeInbound(reports: readonly StatsEntry[], kind: "audio" | "video"): StatsEntry | undefined {
  return reports.find((report) => {
    const received = nonNegativeNumber(report.packetsReceived);
    return report.type === "inbound-rtp" && report.kind === kind && report.active !== false
      && received !== null && received > 0;
  });
}

function jitterMs(report: StatsEntry | undefined): number | null {
  const seconds = nonNegativeNumber(report?.jitter);
  return seconds === null ? null : Math.round(seconds * 1000);
}

export type IceCheckCounts = {
  candidatePairs: number | null;
  remoteCandidates: number | null;
  requestsSent: number | null;
  requestsReceived: number | null;
  responsesSent: number | null;
  responsesReceived: number | null;
};

export function summarizeIceChecks(reports: readonly StatsEntry[]): IceCheckCounts {
  const pairs = reports.filter((report) => report.type === "candidate-pair");
  const sum = (key: keyof IceCheckCounts): number | null => {
    const values = pairs.map((pair) => pair[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    candidatePairs: reports.length ? pairs.length : null,
    remoteCandidates: reports.length ? reports.filter((report) => report.type === "remote-candidate").length : null,
    requestsSent: sum("requestsSent"),
    requestsReceived: sum("requestsReceived"),
    responsesSent: sum("responsesSent"),
    responsesReceived: sum("responsesReceived"),
  };
}

export function summarizeConnectionStats(reports: readonly StatsEntry[]): ConnectionDiagnostics {
  const byId = new Map(reports.map((report) => [report.id, report]));
  const inboundAudioPackets = reports.reduce((count, report) => {
    if (report.type !== "inbound-rtp" || report.kind !== "audio") return count;
    return count + (typeof report.packetsReceived === "number" ? report.packetsReceived : 0);
  }, 0);
  const inboundVideoPackets = reports.reduce((count, report) => {
    if (report.type !== "inbound-rtp" || report.kind !== "video") return count;
    return count + (typeof report.packetsReceived === "number" ? report.packetsReceived : 0);
  }, 0);
  const audio = activeInbound(reports, "audio");
  const video = activeInbound(reports, "video");
  const mediaStats = {
    audioPacketsReceived: nonNegativeNumber(audio?.packetsReceived),
    audioJitterMs: jitterMs(audio),
    audioPacketsLost: nonNegativeNumber(audio?.packetsLost),
    videoPacketsReceived: nonNegativeNumber(video?.packetsReceived),
    videoJitterMs: jitterMs(video),
    videoPacketsLost: nonNegativeNumber(video?.packetsLost),
    videoFreezeCount: nonNegativeNumber(video?.freezeCount),
  };

  // A nominated pair is not necessarily the pair currently carrying media.
  const transport = reports.find((report) => report.type === "transport" && typeof report.selectedCandidatePairId === "string");
  const pair = transport ? byId.get(transport.selectedCandidatePairId as string) : undefined;
  if (!pair || pair.type !== "candidate-pair" || pair.state !== "succeeded") {
    return { inboundAudioPackets, inboundVideoPackets, route: "unknown", roundTripTimeMs: null, ...mediaStats };
  }

  const local = byId.get(pair.localCandidateId as string);
  const remote = byId.get(pair.remoteCandidateId as string);
  const route = routeForCandidateTypes(local?.candidateType, remote?.candidateType);
  const rtt = nonNegativeNumber(pair.currentRoundTripTime);
  return {
    inboundAudioPackets,
    inboundVideoPackets,
    route,
    roundTripTimeMs: rtt === null ? null : Math.round(rtt * 1000),
    ...mediaStats,
  };
}
