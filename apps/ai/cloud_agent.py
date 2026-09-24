"""Opt-in, loopback-only Tencent ASR/TTS + SiliconFlow voice agent.

No credentials are read from other repositories. Set them in the process
environment and explicitly enable potentially billable provider calls.
"""

import asyncio
import base64
import uuid
from collections.abc import AsyncGenerator

from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601

from cloud_timing import CloudTiming
from cloud_voice_config import (
    MAX_SEGMENT_BYTES, MAX_TTS_CHARS, MAX_TURNS, SAMPLE_RATE, require_cloud_config,
)
from cloud_voice_pipeline import assemble_cloud_pipeline
from voice_observability import VoiceState


def make_tencent_clients(secret_id: str, secret_key: str):
    from tencentcloud.asr.v20190614.asr_client import AsrClient
    from tencentcloud.common.credential import Credential
    from tencentcloud.common.profile.client_profile import ClientProfile
    from tencentcloud.common.profile.http_profile import HttpProfile
    from tencentcloud.tts.v20190823.tts_client import TtsClient

    profile = ClientProfile(httpProfile=HttpProfile(reqTimeout=8))
    credentials = Credential(secret_id, secret_key)
    return AsrClient(credentials, "ap-beijing", profile), TtsClient(credentials, "ap-beijing", profile)


class TencentSentenceSTT(SegmentedSTTService):
    def __init__(self, client, timing: CloudTiming | None = None):
        super().__init__(sample_rate=SAMPLE_RATE, settings=STTSettings(model="16k_zh", language=Language.ZH))
        self._client = client
        self._timing = timing
        self._requests = 0

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        if len(audio) < SAMPLE_RATE // 2 or len(audio) > MAX_SEGMENT_BYTES:
            yield ErrorFrame(error="Speech segment must be between 0.25 and 10 seconds")
            return
        if self._requests >= MAX_TURNS:
            yield ErrorFrame(error="Cloud test turn limit reached; hang up")
            return
        self._requests += 1  # Count attempts, including provider errors; never retry automatically.
        try:
            from tencentcloud.asr.v20190614 import models

            request = models.SentenceRecognitionRequest()
            request.EngSerViceType = "16k_zh"
            request.SourceType = 1
            request.VoiceFormat = "wav"
            request.Data = base64.b64encode(audio).decode("ascii")
            request.DataLen = len(audio)
            started = self._timing.clock() if self._timing else None
            response = await asyncio.to_thread(self._client.SentenceRecognition, request)
            if started is not None:
                self._timing.stt_finished(started)
            if response.Result.strip():
                yield TranscriptionFrame(
                    response.Result.strip(), self._user_id, time_now_iso8601(), Language.ZH
                )
        except Exception as error:
            # SDK exceptions can carry request metadata; do not reflect them to the browser.
            yield ErrorFrame(error=f"Tencent ASR failed ({type(error).__name__})")


class TencentTTS(TTSService):
    def __init__(self, client, timing: CloudTiming | None = None):
        super().__init__(
            sample_rate=SAMPLE_RATE,
            push_start_frame=True,
            push_stop_frames=True,
            settings=TTSSettings(model="TextToVoice", voice="402000", language=Language.ZH),
        )
        self._client = client
        self._timing = timing
        self._requests = 0

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        if not text.strip():
            return
        if self._requests >= MAX_TURNS:
            yield ErrorFrame(error="Cloud test turn limit reached; hang up")
            return
        self._requests += 1
        try:
            from tencentcloud.tts.v20190823 import models

            request = models.TextToVoiceRequest()
            request.Text = text.strip()[:MAX_TTS_CHARS]
            request.SessionId = uuid.uuid4().hex
            request.VoiceType = 402000  # Cloud XiaoFu; matches the super-natural trial package.
            request.PrimaryLanguage = 1
            request.SampleRate = SAMPLE_RATE
            request.Codec = "pcm"
            started = self._timing.clock() if self._timing else None
            response = await asyncio.to_thread(self._client.TextToVoice, request)
            pcm = base64.b64decode(response.Audio, validate=True)
            if not pcm or len(pcm) % 2:
                raise ValueError("Invalid PCM response")
            if started is not None:
                self._timing.tts_finished(started)
            await self.start_tts_usage_metrics(request.Text)

            async def chunks():
                for offset in range(0, len(pcm), 6400):
                    yield pcm[offset:offset + 6400]

            async for frame in self._stream_audio_frames_from_iterator(
                chunks(), in_sample_rate=SAMPLE_RATE, context_id=context_id
            ):
                yield frame
        except Exception as error:
            yield ErrorFrame(error=f"Tencent TTS failed ({type(error).__name__})")


def build_cloud_pipeline(transport, state: VoiceState) -> Pipeline:
    secret_id, secret_key, silicon_key = require_cloud_config()
    asr_client, tts_client = make_tencent_clients(secret_id, secret_key)
    timing = CloudTiming(state)
    stt = TencentSentenceSTT(asr_client, timing)
    tts = TencentTTS(tts_client, timing)
    return assemble_cloud_pipeline(
        transport, state, stt, tts, timing, silicon_key,
        "你是语音助手。用简短的中文一句话回答，不要 Markdown、表情或列表。",
    )
