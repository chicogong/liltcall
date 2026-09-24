export type CloudTimingMetrics = {
  latency_turn?: number;
  stt_request_ms?: number | null;
  llm_first_text_ms?: number | null;
  llm_total_ms?: number | null;
  tts_request_ms?: number | null;
  llm_to_first_audio_ms?: number | null;
  stt_final_after_speech_ms?: number | null;
  tts_first_audio_ms?: number | null;
};

/** Format diagnostic elapsed times only; never accepts speech or model text. */
export function formatCloudLatency(
  template: string,
  metrics: CloudTimingMetrics | null,
  firstInboundAudioObservedMs: number | null,
  unavailable: string,
  streaming = false,
): string {
  const measured = (value: number | null | undefined) => value == null ? unavailable : String(value);
  return template
    .replace("{turn}", String(metrics?.latency_turn ?? 0))
    .replace("{stt}", measured(streaming ? metrics?.stt_final_after_speech_ms : metrics?.stt_request_ms))
    .replace("{llmFirst}", measured(metrics?.llm_first_text_ms))
    .replace("{llmTotal}", measured(metrics?.llm_total_ms))
    .replace("{tts}", measured(streaming ? metrics?.tts_first_audio_ms : metrics?.tts_request_ms))
    .replace("{serverAudio}", measured(metrics?.llm_to_first_audio_ms))
    .replace("{browserRtp}", measured(firstInboundAudioObservedMs));
}
