"""Offline protocol and cost-gate tests; no provider credentials or network calls."""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import AsyncMock, Mock, patch

from pipecat.frames.frames import (
    ErrorFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, OutputAudioRawFrame,
    TextFrame, TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.frame_processor import FrameProcessor

from cloud_voice_config import SAMPLE_RATE, require_stream_config
from streaming_cloud import (
    ASR_CHUNK_BYTES, ASR_SILENCE_MS, MAX_AUDIO_SECONDS, TencentFlowingTTS,
    TencentRealtimeSTT, asr_url, build_stream_pipeline, tts_url,
    voice_chunk,
)
from voice_observability import VoiceState


class FakeSocket:
    def __init__(self, *initial, early_audio=False):
        self.messages = asyncio.Queue()
        for message in initial:
            self.messages.put_nowait(message)
        self.sent = []
        self.closed = False
        self.early_audio = early_audio

    async def recv(self):
        return await self.messages.get()

    async def send(self, payload):
        self.sent.append(payload)
        if self.early_audio and isinstance(payload, str) and '"ACTION_SYNTHESIS"' in payload and json.loads(payload)["data"].endswith(("。", "；")):
            await self.messages.put(b"\x04\x05")
            self.early_audio = False
        if isinstance(payload, str) and '"ACTION_COMPLETE"' in payload:
            await self.messages.put(b"\x00")
            await self.messages.put(b"\x01\x02\x03")
            await self.messages.put('{"code":0,"final":1}')

    async def close(self):
        self.closed = True
        await self.messages.put(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.messages.get()
        if item is None:
            raise StopAsyncIteration
        return item


class SigningTests(unittest.TestCase):
    def test_realtime_asr_signature_uses_canonical_path_and_short_expiry(self):
        url = asr_url("1234567890", "test-id", "test-key", now=1000, nonce=42, voice_id="test-voice")
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        self.assertEqual(parts.scheme, "wss")
        self.assertEqual(parts.netloc, "asr.cloud.tencent.com")
        self.assertEqual(query["engine_model_type"], ["16k_zh"])
        self.assertEqual(query["voice_format"], ["1"])
        self.assertEqual(query["vad_silence_time"], [str(ASR_SILENCE_MS)])
        self.assertEqual(query["expired"], ["1120"])
        unsigned = parts.query.rsplit("&signature=", 1)[0]
        expected = base64.b64encode(hmac.new(b"test-key", f"asr.cloud.tencent.com{parts.path}?{unsigned}".encode(), hashlib.sha1).digest()).decode()
        self.assertEqual(query["signature"], [expected])

    def test_flowing_tts_signature_uses_get_prefix_and_pcm_voice(self):
        url = tts_url("1234567890", "test-id", "test-key", "session-one", now=1000)
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        self.assertEqual(query["Action"], ["TextToStreamAudioWSv2"])
        self.assertEqual(query["VoiceType"], ["402000"])
        self.assertEqual(query["Codec"], ["pcm"])
        unsigned = parts.query.rsplit("&Signature=", 1)[0]
        expected = base64.b64encode(hmac.new(b"test-key", f"GETtts.cloud.tencent.com{parts.path}?{unsigned}".encode(), hashlib.sha1).digest()).decode()
        self.assertEqual(query["Signature"], [expected])

    def test_separate_realtime_billing_gate_and_app_id_are_required(self):
        values = {"LILTCALL_AI_CLOUD_ALLOW_BILLING": "1", "TENCENTCLOUD_SECRET_ID": "test-id",
                  "TENCENTCLOUD_SECRET_KEY": "test-key", "SILICONFLOW_API_KEY": "test-key",
                  "TENCENTCLOUD_APP_ID": "1234567890"}
        with patch.dict(os.environ, values, clear=True):
            with self.assertRaisesRegex(RuntimeError, "Realtime ASR/TTS disabled"):
                require_stream_config()
            os.environ["LILTCALL_AI_REALTIME_ALLOW_BILLING"] = "1"
            self.assertEqual(require_stream_config()[0], "1234567890")
            os.environ["TENCENTCLOUD_APP_ID"] = "not-an-id"
            with self.assertRaisesRegex(RuntimeError, "AppID"):
                require_stream_config()

    def test_stream_pipeline_builds_without_provider_calls(self):
        transport = Mock()
        transport.input.return_value = FrameProcessor()
        transport.output.return_value = FrameProcessor()
        values = {"LILTCALL_AI_CLOUD_ALLOW_BILLING": "1", "LILTCALL_AI_REALTIME_ALLOW_BILLING": "1",
                  "TENCENTCLOUD_SECRET_ID": "test-id", "TENCENTCLOUD_SECRET_KEY": "test-key",
                  "SILICONFLOW_API_KEY": "test-key", "TENCENTCLOUD_APP_ID": "1234567890"}
        with patch.dict(os.environ, values, clear=True):
            self.assertIsNotNone(build_stream_pipeline(transport, VoiceState()))


class StreamingProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_long_clause_comma_starts_audio_before_llm_finishes(self):
        socket = FakeSocket('{"code":0}', '{"code":0,"ready":1}', early_audio=True)

        async def connect(_url, **_kwargs):
            return socket

        state = VoiceState()
        audio_seen = asyncio.Event()
        forwarded_text = []
        tts = TencentFlowingTTS("1234567890", "test-id", "test-key", state, connect=connect)

        async def forward(frame, _direction=FrameDirection.DOWNSTREAM):
            if isinstance(frame, OutputAudioRawFrame):
                audio_seen.set()
            if isinstance(frame, TextFrame):
                forwarded_text.append(frame.text)

        tts.push_frame = forward
        await tts.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
        await tts.process_frame(TextFrame("这个方案能明显减少等待时间，"), FrameDirection.DOWNSTREAM)
        await asyncio.wait_for(audio_seen.wait(), 1)
        self.assertIsNotNone(state.tts_first_audio_ms)
        self.assertEqual(json.loads(socket.sent[0])["data"], "这个方案能明显减少等待时间；")
        self.assertEqual(forwarded_text, ["这个方案能明显减少等待时间，"])
        self.assertFalse(any('"ACTION_COMPLETE"' in item for item in socket.sent))
        await tts.process_frame(TextFrame("后续还可以继续优化。"), FrameDirection.DOWNSTREAM)
        await tts.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)

    async def test_short_clause_comma_is_preserved(self):
        self.assertEqual(voice_chunk("你好，", 0), ("你好，", 2))
        self.assertEqual(voice_chunk("这是一个较长的分句", 0)[1], 9)

    async def test_tts_error_does_not_echo_provider_message(self):
        socket = FakeSocket('{"code":10003,"message":"private-provider-detail"}')

        async def connect(_url, **_kwargs):
            return socket

        errors = []
        tts = TencentFlowingTTS("1234567890", "test-id", "test-key", VoiceState(), connect=connect)

        async def forward(frame, _direction=FrameDirection.DOWNSTREAM):
            if isinstance(frame, ErrorFrame):
                errors.append(frame.error)

        tts.push_frame = forward
        await tts.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
        self.assertTrue(socket.closed)
        self.assertEqual(len(errors), 1)
        self.assertNotIn("private-provider-detail", errors[0])

    async def test_asr_sends_200ms_pcm_and_emits_only_unique_stable_sentences(self):
        socket = FakeSocket()
        state = VoiceState()
        stt = TencentRealtimeSTT("1234567890", "test-id", "test-key", state)
        stt._ws = socket
        stt.push_frame = AsyncMock()
        async for _ in stt.run_stt(bytes(ASR_CHUNK_BYTES // 2)):
            pass
        self.assertEqual(socket.sent, [])
        async for _ in stt.run_stt(bytes(ASR_CHUNK_BYTES // 2)):
            pass
        self.assertEqual(socket.sent, [bytes(ASR_CHUNK_BYTES)])
        await socket.messages.put('{"code":0,"result":{"slice_type":1,"index":0,"voice_text_str":"不稳定"}}')
        await socket.messages.put('{"code":0,"result":{"slice_type":2,"index":0,"voice_text_str":"你好"}}')
        await socket.messages.put('{"code":0,"result":{"slice_type":2,"index":0,"voice_text_str":"重复"}}')
        await socket.messages.put('{"code":0,"final":1}')
        await stt._read_results()
        transcripts = [call.args[0] for call in stt.push_frame.await_args_list if isinstance(call.args[0], TranscriptionFrame)]
        self.assertEqual(len(transcripts), 1)
        self.assertEqual(transcripts[0].text, "你好")
        self.assertTrue(transcripts[0].finalized)

    async def test_tts_accepts_text_chunks_and_returns_pcm_before_final(self):
        socket = FakeSocket('{"code":0,"final":0}', '{"code":0,"ready":1}')

        async def connect(_url, **_kwargs):
            return socket

        state = VoiceState()
        tts = TencentFlowingTTS("1234567890", "test-id", "test-key", state, connect=connect)
        tts.push_frame = AsyncMock()
        await tts.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
        await tts.process_frame(TextFrame("你好"), FrameDirection.DOWNSTREAM)
        await tts.process_frame(TextFrame("，世界"), FrameDirection.DOWNSTREAM)
        await tts.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
        commands = [json.loads(payload) for payload in socket.sent]
        self.assertEqual([item["action"] for item in commands],
                         ["ACTION_SYNTHESIS", "ACTION_SYNTHESIS", "ACTION_SYNTHESIS", "ACTION_COMPLETE"])
        self.assertEqual([item["data"] for item in commands[:-1]], ["你好", "，世界", "。"])
        audio = [call.args[0] for call in tts.push_frame.await_args_list if isinstance(call.args[0], OutputAudioRawFrame)]
        self.assertEqual(len(audio), 1)  # Odd WebSocket chunks are PCM-aligned before forwarding.
        self.assertEqual(b"".join(frame.audio for frame in audio), b"\x00\x01\x02\x03")
        self.assertIsNotNone(state.tts_first_audio_ms)
        self.assertTrue(socket.closed)

    async def test_tts_can_forward_pcm_before_llm_completion(self):
        socket = FakeSocket('{"code":0}', '{"code":0,"ready":1}', early_audio=True)

        async def connect(_url, **_kwargs):
            return socket

        seen = asyncio.Event()
        tts = TencentFlowingTTS("1234567890", "test-id", "test-key", VoiceState(), connect=connect)

        async def forward(frame, _direction=FrameDirection.DOWNSTREAM):
            if isinstance(frame, OutputAudioRawFrame):
                seen.set()

        tts.push_frame = forward
        await tts.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
        await tts.process_frame(TextFrame("你好。"), FrameDirection.DOWNSTREAM)
        await asyncio.wait_for(seen.wait(), 1)
        self.assertFalse(any('"ACTION_COMPLETE"' in item for item in socket.sent if isinstance(item, str)))
        await tts.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)

    async def test_asr_audio_limit_ends_stream_without_sending_extra_pcm(self):
        socket = FakeSocket()
        stt = TencentRealtimeSTT("1234567890", "test-id", "test-key", VoiceState())
        stt._ws = socket
        stt._sent_bytes = MAX_AUDIO_SECONDS * SAMPLE_RATE * 2
        async for _ in stt.run_stt(bytes(ASR_CHUNK_BYTES)):
            pass
        self.assertEqual(socket.sent, ['{"type":"end"}'])
        self.assertFalse(stt._accept_audio)


if __name__ == "__main__":
    unittest.main()
