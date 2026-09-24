"""Optional, fully local STT → LLM → TTS pipeline. Models are not bundled."""

import os

from pipecat.frames.frames import OutputAudioRawFrame, TextFrame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from voice_observability import CountFrames, InputDiagnostics, VoiceState


def build_local_pipeline(transport: SmallWebRTCTransport, state: VoiceState) -> Pipeline:
    # These imports are intentionally lazy: the no-key audio probe needs no model packages.
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
        LLMUserAggregatorParams,
    )
    from pipecat.services.ollama.llm import OLLamaLLMService
    from pipecat.services.pocket_tts.tts import PocketTTSService
    from pipecat.services.whisper.stt import WhisperSTTService
    from pipecat.transcriptions.language import Language

    stt = WhisperSTTService(
        settings=WhisperSTTService.Settings(
            model=os.environ.get("LILTCALL_AI_WHISPER_MODEL", "tiny"),
            language=Language.EN,
        ),
        device="cpu",
        compute_type="int8",
    )
    llm = OLLamaLLMService(
        base_url="http://127.0.0.1:11434/v1",
        settings=OLLamaLLMService.Settings(
            model=os.environ.get("LILTCALL_AI_OLLAMA_MODEL", "qwen2.5:0.5b"),
            system_instruction=(
                "You are a friendly voice assistant. Reply in English in one short sentence. "
                "Do not use markdown, emojis, or lists. If the user did not ask a question, "
                "acknowledge them briefly."
            ),
        ),
    )
    tts = PocketTTSService(settings=PocketTTSService.Settings(voice="alba", language=Language.EN))
    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )
    return Pipeline([
        transport.input(),
        InputDiagnostics(state),
        stt,
        CountFrames(state, TranscriptionFrame, "transcriptions"),
        user_aggregator,
        llm,
        CountFrames(state, TextFrame, "llm_text_frames"),
        tts,
        CountFrames(state, OutputAudioRawFrame, "tts_audio_frames"),
        transport.output(),
        assistant_aggregator,
    ])
