"""Content-free counters shared by local, batch-cloud and streaming voice modes."""

from dataclasses import dataclass

from pipecat.frames.frames import (
    Frame, InputAudioRawFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass
class VoiceState:
    input_frames: int = 0
    nonzero_audio_detected: bool = False
    vad_starts: int = 0
    vad_stops: int = 0
    transcriptions: int = 0
    llm_text_frames: int = 0
    tts_audio_frames: int = 0
    # Cloud-only timings for the latest turn; null means not observed.
    latency_turn: int = 0
    stt_request_ms: int | None = None
    llm_first_text_ms: int | None = None
    llm_total_ms: int | None = None
    tts_request_ms: int | None = None
    llm_to_first_audio_ms: int | None = None
    stt_final_after_speech_ms: int | None = None
    tts_first_audio_ms: int | None = None


class CountFrames(FrameProcessor):
    """Record counts only; never retain microphone data or transcript text."""

    def __init__(self, state: VoiceState, frame_type: type[Frame], field: str):
        super().__init__()
        self._state = state
        self._frame_type = frame_type
        self._field = field

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, self._frame_type):
            setattr(self._state, self._field, getattr(self._state, self._field) + 1)
        await self.push_frame(frame, direction)


class InputDiagnostics(FrameProcessor):
    """Count audio and VAD signals without retaining samples or transcript content."""

    def __init__(self, state: VoiceState):
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self._state.input_frames += 1
            self._state.nonzero_audio_detected |= any(frame.audio)
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            self._state.vad_starts += 1
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self._state.vad_stops += 1
        await self.push_frame(frame, direction)
