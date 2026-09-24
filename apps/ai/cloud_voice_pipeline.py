"""One cloud media graph; batch and streaming modes supply their own STT/TTS."""

from pipecat.frames.frames import OutputAudioRawFrame, TextFrame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline

from cloud_timing import CloudTiming, CloudTimingFrames
from voice_observability import CountFrames, InputDiagnostics, VoiceState


def assemble_cloud_pipeline(transport, state: VoiceState, stt, tts, timing: CloudTiming,
                            silicon_key: str, system_instruction: str) -> Pipeline:
    # Lazy imports keep the no-key WebRTC probe free of cloud model dependencies.
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair, LLMUserAggregatorParams,
    )
    from pipecat.services.openai.llm import OpenAILLMService

    llm = OpenAILLMService(
        api_key=silicon_key,
        base_url="https://api.siliconflow.cn/v1",
        retry_on_timeout=False,
        settings=OpenAILLMService.Settings(
            model="Qwen/Qwen2.5-7B-Instruct",
            max_tokens=80,
            system_instruction=system_instruction,
        ),
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        LLMContext(), user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer())
    )
    return Pipeline([
        transport.input(), InputDiagnostics(state), stt,
        CountFrames(state, TranscriptionFrame, "transcriptions"),
        user_aggregator, CloudTimingFrames(timing, "before_llm"), llm,
        CloudTimingFrames(timing, "after_llm"),
        CountFrames(state, TextFrame, "llm_text_frames"),
        tts, CloudTimingFrames(timing, "after_tts"),
        CountFrames(state, OutputAudioRawFrame, "tts_audio_frames"),
        transport.output(), assistant_aggregator,
    ])
