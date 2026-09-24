/** Simulate a browser that omits RTCTransportStats.selectedCandidatePairId. */
export function stripSelectedPairId(): void {
  const nativeGetStats = RTCPeerConnection.prototype.getStats;
  RTCPeerConnection.prototype.getStats = async function(selector?: MediaStreamTrack | null): Promise<RTCStatsReport> {
    const reports = new Map(await nativeGetStats.call(this, selector));
    for (const [id, report] of reports) {
      if (report.type !== "transport") continue;
      const copy = { ...report } as RTCStats & { selectedCandidatePairId?: string };
      delete copy.selectedCandidatePairId;
      reports.set(id, copy);
    }
    return reports;
  };
}
