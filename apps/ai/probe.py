"""Deterministic, no-key audio-path probe. This is not speech recognition or an AI bot."""

from array import array
from dataclasses import dataclass
from math import pi, sin

from pipecat.frames.frames import Frame, InputAudioRawFrame, OutputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass
class ProbeState:
    input_frames: int = 0
    nonzero_audio_detected: bool = False
    response_sent: bool = False


def tone(sample_rate: int = 16000, frequency: int = 660, duration_ms: int = 500) -> bytes:
    """Generate a short, quiet PCM tone; never send microphone audio back as an echo."""
    samples = array("h")
    count = sample_rate * duration_ms // 1000
    fade = sample_rate // 100
    for index in range(count):
        envelope = min(1.0, index / fade, (count - index - 1) / fade)
        samples.append(int(6000 * max(0.0, envelope) * sin(2 * pi * frequency * index / sample_rate)))
    return samples.tobytes()


class AudioPathProbe(FrameProcessor):
    """Return one test tone only after receiving non-silent browser microphone PCM."""

    def __init__(self, state: ProbeState):
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self._state.input_frames += 1
            samples = array("h")
            samples.frombytes(frame.audio)
            if samples and max(abs(sample) for sample in samples) > 300:
                self._state.nonzero_audio_detected = True
                if not self._state.response_sent:
                    self._state.response_sent = True
                    await self.push_frame(
                        OutputAudioRawFrame(audio=tone(), sample_rate=16000, num_channels=1)
                    )
        await self.push_frame(frame, direction)
