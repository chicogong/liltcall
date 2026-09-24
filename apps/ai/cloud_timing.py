"""Content-free, per-connection timing for the opt-in cloud voice prototype.

All values are elapsed monotonic milliseconds. The latest turn replaces the
previous turn; no audio, transcripts, prompts, or provider credentials are kept.
"""

import time
from collections.abc import Callable
from typing import Literal

from pipecat.frames.frames import (
    Frame, LLMContextFrame, LLMFullResponseEndFrame, OutputAudioRawFrame, TextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from voice_observability import VoiceState


class CloudTiming:
    def __init__(self, state: VoiceState, clock: Callable[[], float] = time.perf_counter):
        self.state = state
        self.clock = clock
        self._llm_started: float | None = None
        self._first_text: float | None = None

    def stt_finished(self, started: float) -> None:
        self.state.stt_request_ms = self._elapsed(started)

    def tts_finished(self, started: float) -> None:
        # TextToVoice is non-streaming. Only the first call of a turn is the
        # latency on the path to first reply audio.
        if self.state.tts_request_ms is None:
            self.state.tts_request_ms = self._elapsed(started)

    def llm_started(self) -> None:
        self._llm_started = self.clock()
        self._first_text = None
        self.state.latency_turn += 1
        self.state.llm_first_text_ms = None
        self.state.llm_total_ms = None
        self.state.tts_request_ms = None
        self.state.llm_to_first_audio_ms = None
        self.state.tts_first_audio_ms = None

    def llm_text(self) -> None:
        if self._llm_started is not None and self._first_text is None:
            self._first_text = self.clock()
            self.state.llm_first_text_ms = self._elapsed(self._llm_started, self._first_text)

    def llm_finished(self) -> None:
        if self._llm_started is not None:
            self.state.llm_total_ms = self._elapsed(self._llm_started)

    def first_audio(self) -> None:
        if self._llm_started is not None and self.state.llm_to_first_audio_ms is None:
            self.state.llm_to_first_audio_ms = self._elapsed(self._llm_started)

    def _elapsed(self, started: float, now: float | None = None) -> int:
        return max(0, round(((self.clock() if now is None else now) - started) * 1000))


class CloudTimingFrames(FrameProcessor):
    """Observe frame boundaries without modifying the Pipecat media flow."""

    def __init__(self, timing: CloudTiming, position: Literal["before_llm", "after_llm", "after_tts"]):
        super().__init__()
        self._timing = timing
        self._position = position

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if self._position == "before_llm" and isinstance(frame, LLMContextFrame):
                self._timing.llm_started()
            elif self._position == "after_llm":
                if isinstance(frame, TextFrame):
                    self._timing.llm_text()
                elif isinstance(frame, LLMFullResponseEndFrame):
                    self._timing.llm_finished()
            elif self._position == "after_tts" and isinstance(frame, OutputAudioRawFrame):
                self._timing.first_audio()
        await self.push_frame(frame, direction)
