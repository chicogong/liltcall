import { describe, expect, it } from "vitest";
import { formatCloudLatency } from "../apps/web/src/ai-latency";

const template = "turn={turn} stt={stt} first={llmFirst} total={llmTotal} tts={tts} audio={serverAudio} rtp={browserRtp}";

describe("private AI latency diagnostics", () => {
  it("shows unobserved stages as unavailable rather than zero", () => {
    expect(formatCloudLatency(template, null, null, "—"))
      .toBe("turn=0 stt=— first=— total=— tts=— audio=— rtp=—");
  });

  it("formats one measured turn without leaking content", () => {
    const output = formatCloudLatency(template, {
      latency_turn: 1, stt_request_ms: 630, llm_first_text_ms: 280,
      llm_total_ms: 1140, tts_request_ms: 1420, llm_to_first_audio_ms: 2000,
    }, 6690, "—");
    expect(output).toBe("turn=1 stt=630 first=280 total=1140 tts=1420 audio=2000 rtp=6690");
  });

  it("uses realtime ASR and first-PCM timings for the streaming mode", () => {
    expect(formatCloudLatency(template, {
      latency_turn: 2, stt_request_ms: 999, tts_request_ms: 999,
      stt_final_after_speech_ms: 210, tts_first_audio_ms: 350,
    }, 1800, "—", true))
      .toBe("turn=2 stt=210 first=— total=— tts=350 audio=— rtp=1800");
  });
});
