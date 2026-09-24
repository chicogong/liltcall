"""Opt-in Tencent realtime ASR and flowing-text TTS for private WebRTC calls.

Protocol reference: Tencent realtime ASR (asr/v2) and TextToStreamAudioWSv2.
Never log signed URLs, provider messages, transcript text, or audio payloads.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid
from collections.abc import AsyncGenerator
from urllib.parse import quote, urlencode

import websockets
from pipecat.frames.frames import (
    CancelFrame, EndFrame, ErrorFrame, Frame, InterruptionFrame,
    LLMFullResponseEndFrame, LLMFullResponseStartFrame, OutputAudioRawFrame,
    TextFrame, TranscriptionFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import STTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601

from cloud_timing import CloudTiming
from cloud_voice_config import MAX_TTS_CHARS, MAX_TURNS, SAMPLE_RATE, require_stream_config
from cloud_voice_pipeline import assemble_cloud_pipeline
from voice_observability import VoiceState

ASR_CHUNK_BYTES = SAMPLE_RATE * 2 // 5  # 200 ms, as recommended by Tencent.
MAX_AUDIO_SECONDS = 45  # Per-connection cost guard; not an account-level budget.
CONNECT_TIMEOUT = 5
FINAL_TIMEOUT = 30
ASR_SILENCE_MS = 600  # Lower than the prior 700 ms; validate false splits with real speech.
TTS_CLAUSE_CHARS = 12  # Only split a substantial clause; keep short commas natural.
TTS_SENTENCE_ENDINGS = "。！？；;?!\n"


def voice_chunk(text: str, since_boundary: int) -> tuple[str, int]:
    """Give Tencent an early synthesis boundary at a long clause's comma.

    This affects speech prosody only, never the LLM text or saved context.
    Tencent's flowing TTS buffers until sentence-ending punctuation.
    """
    spoken = []
    for char in text:
        if char in TTS_SENTENCE_ENDINGS:
            spoken.append(char)
            since_boundary = 0
        elif char in "，," and since_boundary >= TTS_CLAUSE_CHARS:
            spoken.append("；")
            since_boundary = 0
        else:
            spoken.append(char)
            if not char.isspace() and char not in "，,":
                since_boundary += 1
    return "".join(spoken), since_boundary


def _signed_url(path: str, params: dict[str, str | int], secret_key: str, *, method_prefix: str = "", signature_key: str) -> str:
    query = urlencode(sorted(params.items()), quote_via=quote, safe="")
    source = f"{method_prefix}{path}?{query}"
    signature = base64.b64encode(hmac.new(secret_key.encode(), source.encode(), hashlib.sha1).digest()).decode()
    return f"wss://{path}?{query}&{signature_key}={quote(signature, safe='')}"


def asr_url(app_id: str, secret_id: str, secret_key: str, *, now: int | None = None, nonce: int | None = None, voice_id: str | None = None) -> str:
    timestamp = int(time.time()) if now is None else now
    return _signed_url(f"asr.cloud.tencent.com/asr/v2/{app_id}", {
        "engine_model_type": "16k_zh", "expired": timestamp + 120,
        "needvad": 1, "nonce": secrets.randbelow(1_000_000_000) + 1 if nonce is None else nonce,
        "secretid": secret_id, "timestamp": timestamp, "vad_silence_time": ASR_SILENCE_MS,
        "voice_format": 1, "voice_id": voice_id or uuid.uuid4().hex,
    }, secret_key, signature_key="signature")


def tts_url(app_id: str, secret_id: str, secret_key: str, session_id: str, *, now: int | None = None) -> str:
    timestamp = int(time.time()) if now is None else now
    return _signed_url("tts.cloud.tencent.com/stream_wsv2", {
        "Action": "TextToStreamAudioWSv2", "AppId": int(app_id), "Codec": "pcm",
        "Expired": timestamp + 120, "SampleRate": SAMPLE_RATE,
        "SecretId": secret_id, "SessionId": session_id,
        "Timestamp": timestamp, "VoiceType": 402000,
    }, secret_key, method_prefix="GET", signature_key="Signature")


def _event(message: str | bytes) -> dict:
    if not isinstance(message, str):
        raise ValueError("Expected provider control event")
    event = json.loads(message)
    if not isinstance(event, dict) or event.get("code") != 0:
        raise ValueError("Provider returned a non-success control event")
    return event


class TencentRealtimeSTT(STTService):
    """Send live 16-kHz PCM; emit only stable sentence results into the LLM."""

    def __init__(self, app_id: str, secret_id: str, secret_key: str, state: VoiceState, *, connect=websockets.connect):
        super().__init__(audio_passthrough=True, sample_rate=SAMPLE_RATE,
                         settings=STTSettings(model="16k_zh", language=Language.ZH))
        self._app_id, self._secret_id, self._secret_key = app_id, secret_id, secret_key
        self._state = state
        self._connect = connect
        self._ws = None
        self._reader: asyncio.Task | None = None
        self._pcm = bytearray()
        self._sent_bytes = 0
        self._stable_indices: set[int] = set()
        self._speech_stopped_at: float | None = None
        self._accept_audio = True

    async def start(self, frame):
        await super().start(frame)
        try:
            self._ws = await asyncio.wait_for(self._connect(
                asr_url(self._app_id, self._secret_id, self._secret_key),
                open_timeout=CONNECT_TIMEOUT, close_timeout=2, max_size=65_536,
            ), CONNECT_TIMEOUT + 1)
            await asyncio.wait_for(self._handshake(), CONNECT_TIMEOUT)
            self._reader = asyncio.create_task(self._read_results())
        except Exception as error:
            await self._close()
            await self.set_usable(False)
            await self.push_error_frame(ErrorFrame(error=f"Realtime ASR connect failed ({type(error).__name__})"))

    async def _handshake(self):
        _event(await self._ws.recv())

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]:
        if not self._ws or not self._accept_audio:
            return
        self._pcm.extend(audio)
        try:
            while len(self._pcm) >= ASR_CHUNK_BYTES and self._accept_audio:
                chunk = bytes(self._pcm[:ASR_CHUNK_BYTES])
                del self._pcm[:ASR_CHUNK_BYTES]
                if self._sent_bytes + len(chunk) > MAX_AUDIO_SECONDS * SAMPLE_RATE * 2:
                    self._accept_audio = False
                    await self._ws.send('{"type":"end"}')
                    break
                await self._ws.send(chunk)
                self._sent_bytes += len(chunk)
        except Exception as error:
            self._accept_audio = False
            yield ErrorFrame(error=f"Realtime ASR send failed ({type(error).__name__})")

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if isinstance(frame, VADUserStoppedSpeakingFrame) and direction == FrameDirection.DOWNSTREAM:
            self._speech_stopped_at = time.perf_counter()
            self._state.stt_final_after_speech_ms = None
        await super().process_frame(frame, direction)

    async def _read_results(self):
        try:
            async for message in self._ws:
                event = _event(message)
                result = event.get("result") or {}
                if result.get("slice_type") == 2:
                    index = result.get("index")
                    transcript = result.get("voice_text_str", "")
                    if isinstance(index, int) and index not in self._stable_indices and isinstance(transcript, str):
                        self._stable_indices.add(index)
                        if transcript.strip():
                            if self._speech_stopped_at is not None:
                                self._state.stt_final_after_speech_ms = max(0, round((time.perf_counter() - self._speech_stopped_at) * 1000))
                                self._speech_stopped_at = None
                            await self.push_frame(TranscriptionFrame(
                                transcript.strip(), self._user_id, time_now_iso8601(), Language.ZH,
                                finalized=True,
                            ))
                        if len(self._stable_indices) >= MAX_TURNS and self._accept_audio:
                            self._accept_audio = False
                            await self._ws.send('{"type":"end"}')
                if event.get("final") == 1:
                    break
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._accept_audio = False
            await self.push_error_frame(ErrorFrame(error=f"Realtime ASR receive failed ({type(error).__name__})"))

    async def _close(self):
        if self._ws:
            await self._ws.close()
            self._ws = None
        if self._reader:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
            self._reader = None

    async def stop(self, frame: EndFrame):
        await self._close()
        await super().stop(frame)

    async def cancel(self, frame: CancelFrame):
        await self._close()
        await super().cancel(frame)

    async def cleanup(self):
        await self._close()
        await super().cleanup()


class TencentFlowingTTS(FrameProcessor):
    """Forward LLM text chunks to one WebSocket per turn; forward PCM immediately."""

    def __init__(self, app_id: str, secret_id: str, secret_key: str, state: VoiceState, *, connect=websockets.connect):
        super().__init__()
        self._app_id, self._secret_id, self._secret_key = app_id, secret_id, secret_key
        self._state = state
        self._connect = connect
        self._ws = None
        self._reader: asyncio.Task | None = None
        self._finished: asyncio.Event | None = None
        self._session_id = ""
        self._sent_chars = 0
        self._last_char = ""
        self._since_boundary = 0
        self._first_text_at: float | None = None
        self._turns = 0
        self._got_final = False

    async def _open(self):
        if self._turns >= MAX_TURNS:
            await self.push_frame(ErrorFrame(error="Cloud test turn limit reached; hang up"))
            return
        self._turns += 1
        self._session_id = uuid.uuid4().hex
        self._sent_chars = 0
        self._last_char = ""
        self._since_boundary = 0
        self._first_text_at = None
        self._got_final = False
        self._finished = asyncio.Event()
        try:
            self._ws = await asyncio.wait_for(self._connect(
                tts_url(self._app_id, self._secret_id, self._secret_key, self._session_id),
                open_timeout=CONNECT_TIMEOUT, close_timeout=2, max_size=65_536,
            ), CONNECT_TIMEOUT + 1)
            # The first success frame is the handshake; READY may follow separately.
            for _ in range(4):
                event = _event(await asyncio.wait_for(self._ws.recv(), CONNECT_TIMEOUT))
                if event.get("ready") == 1:
                    self._reader = asyncio.create_task(self._read_audio())
                    return
            raise ValueError("TTS READY event missing")
        except Exception as error:
            await self._close()
            await self.push_frame(ErrorFrame(error=f"Flowing TTS connect failed ({type(error).__name__})"))

    async def _send(self, action: str, data: str = ""):
        if self._ws:
            await self._ws.send(json.dumps({
                "session_id": self._session_id, "message_id": uuid.uuid4().hex,
                "action": action, "data": data,
            }, ensure_ascii=False))

    async def _read_audio(self):
        pending = b""
        try:
            async for message in self._ws:
                if isinstance(message, bytes):
                    pcm = pending + message
                    aligned = len(pcm) & ~1
                    pending = pcm[aligned:]
                    if aligned:
                        if self._first_text_at is not None and self._state.tts_first_audio_ms is None:
                            self._state.tts_first_audio_ms = max(0, round((time.perf_counter() - self._first_text_at) * 1000))
                        await self.push_frame(OutputAudioRawFrame(pcm[:aligned], SAMPLE_RATE, 1))
                elif _event(message).get("final") == 1:
                    self._got_final = True
                    break
            if pending:
                raise ValueError("Odd-length PCM stream")
            if not self._got_final:
                raise ValueError("TTS stream closed before FINAL")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self.push_frame(ErrorFrame(error=f"Flowing TTS receive failed ({type(error).__name__})"))
        finally:
            if self._finished:
                self._finished.set()

    async def _close(self):
        if self._ws:
            await self._ws.close()
            self._ws = None
        if self._reader:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
            self._reader = None
        if self._finished:
            self._finished.set()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            try:
                if isinstance(frame, LLMFullResponseStartFrame):
                    await self._close()
                    await self._open()
                elif isinstance(frame, TextFrame) and not isinstance(frame, TranscriptionFrame) and not frame.skip_tts and self._ws:
                    # Reserve one character for a terminal punctuation flush.
                    text = frame.text[:max(0, MAX_TTS_CHARS - 1 - self._sent_chars)]
                    if text:
                        spoken, self._since_boundary = voice_chunk(text, self._since_boundary)
                        if self._first_text_at is None:
                            self._first_text_at = time.perf_counter()
                        await self._send("ACTION_SYNTHESIS", spoken)
                        self._sent_chars += len(spoken)
                        self._last_char = spoken[-1]
                elif isinstance(frame, LLMFullResponseEndFrame) and self._ws:
                    if self._sent_chars:
                        if self._last_char not in TTS_SENTENCE_ENDINGS:
                            await self._send("ACTION_SYNTHESIS", "。")
                        await self._send("ACTION_COMPLETE")
                        await asyncio.wait_for(self._finished.wait(), FINAL_TIMEOUT)
                        if not self._got_final:
                            raise ValueError("TTS did not finish")
                    await self._close()
                elif isinstance(frame, (EndFrame, CancelFrame, InterruptionFrame)):
                    await self._close()
            except Exception as error:
                await self._close()
                await self.push_frame(ErrorFrame(error=f"Flowing TTS failed ({type(error).__name__})"))
        await self.push_frame(frame, direction)


def build_stream_pipeline(transport, state: VoiceState) -> Pipeline:
    app_id, secret_id, secret_key, silicon_key = require_stream_config()
    timing = CloudTiming(state)
    stt = TencentRealtimeSTT(app_id, secret_id, secret_key, state)
    tts = TencentFlowingTTS(app_id, secret_id, secret_key, state)
    return assemble_cloud_pipeline(
        transport, state, stt, tts, timing, silicon_key,
        "你是语音助手。用简短中文直接回答。优先在前12个汉字内给出有信息的短句并加句号，"
        "必要时再补充一句。不要 Markdown、表情或列表。",
    )
