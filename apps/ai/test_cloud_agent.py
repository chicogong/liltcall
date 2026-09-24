"""Provider contract tests; never contact cloud services or load real credentials."""

import base64
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from pipecat.frames.frames import (
    ErrorFrame, LLMContextFrame, LLMFullResponseEndFrame, OutputAudioRawFrame,
    TTSAudioRawFrame, TextFrame, TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.frame_processor import FrameProcessor

from cloud_agent import TencentSentenceSTT, TencentTTS, build_cloud_pipeline
from cloud_timing import CloudTiming, CloudTimingFrames
from cloud_voice_config import MAX_TURNS, require_cloud_config
from voice_observability import VoiceState


class TimingTests(unittest.TestCase):
    def test_latest_turn_uses_monotonic_elapsed_time_and_keeps_no_content(self):
        now = [10.0]
        state = VoiceState()
        timing = CloudTiming(state, lambda: now[0])
        timing.stt_finished(9.5)
        timing.llm_started()
        now[0] = 10.2
        timing.llm_text()
        now[0] = 10.5
        timing.tts_finished(10.3)
        timing.first_audio()
        now[0] = 10.7
        timing.llm_finished()
        self.assertEqual((state.latency_turn, state.stt_request_ms, state.llm_first_text_ms,
                          state.llm_total_ms, state.tts_request_ms, state.llm_to_first_audio_ms),
                         (1, 500, 200, 700, 200, 500))
        timing.llm_started()
        self.assertEqual(state.latency_turn, 2)
        self.assertIsNone(state.llm_first_text_ms)
        self.assertIsNone(state.tts_request_ms)
        self.assertIsNone(state.llm_to_first_audio_ms)
        self.assertNotIn("text", vars(state))


class TimingFrameTests(unittest.IsolatedAsyncioTestCase):
    async def test_pipeline_boundaries_are_observed_without_changing_frames(self):
        now = [1.0]
        state = VoiceState()
        timing = CloudTiming(state, lambda: now[0])
        before = CloudTimingFrames(timing, "before_llm")
        after = CloudTimingFrames(timing, "after_llm")
        output = CloudTimingFrames(timing, "after_tts")
        for processor in (before, after, output):
            processor.push_frame = AsyncMock()
        context = LLMContextFrame(context=Mock())
        text = TextFrame("secret text is never retained")
        audio = OutputAudioRawFrame(audio=bytes(640), sample_rate=16_000, num_channels=1)
        await before.process_frame(context, FrameDirection.DOWNSTREAM)
        now[0] = 1.25
        await after.process_frame(text, FrameDirection.DOWNSTREAM)
        now[0] = 1.4
        await output.process_frame(audio, FrameDirection.DOWNSTREAM)
        now[0] = 1.5
        await after.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
        self.assertEqual((state.llm_first_text_ms, state.llm_to_first_audio_ms, state.llm_total_ms),
                         (250, 400, 500))
        before.push_frame.assert_awaited_once_with(context, FrameDirection.DOWNSTREAM)
        after.push_frame.assert_any_await(text, FrameDirection.DOWNSTREAM)
        output.push_frame.assert_awaited_once_with(audio, FrameDirection.DOWNSTREAM)
        self.assertNotIn("secret", repr(state))


class ConfigurationTests(unittest.TestCase):
    def test_cloud_requires_separate_billing_opt_in(self):
        with patch.dict(os.environ, {
            "TENCENTCLOUD_SECRET_ID": "test-id",
            "TENCENTCLOUD_SECRET_KEY": "test-secret",
            "SILICONFLOW_API_KEY": "test-key",
            "LILTCALL_AI_CLOUD_ALLOW_BILLING": "0",
        }):
            with self.assertRaisesRegex(RuntimeError, "disabled"):
                require_cloud_config()

    def test_cloud_requires_all_three_credentials(self):
        with patch.dict(os.environ, {"LILTCALL_AI_CLOUD_ALLOW_BILLING": "1"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "Missing cloud credentials"):
                require_cloud_config()

    def test_cloud_pipeline_builds_without_contacting_providers(self):
        transport = Mock()
        transport.input.return_value = FrameProcessor()
        transport.output.return_value = FrameProcessor()
        credentials = {
            "LILTCALL_AI_CLOUD_ALLOW_BILLING": "1",
            "TENCENTCLOUD_SECRET_ID": "test-id",
            "TENCENTCLOUD_SECRET_KEY": "test-secret",
            "SILICONFLOW_API_KEY": "test-key",
        }
        with patch.dict(os.environ, credentials), patch("cloud_agent.make_tencent_clients", return_value=(Mock(), Mock())) as clients:
            pipeline = build_cloud_pipeline(transport, VoiceState())
        self.assertIsNotNone(pipeline)
        clients.assert_called_once()


class ProviderContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_timings_cover_successful_sdk_response(self):
        now = [1.0]
        state = VoiceState()
        timing = CloudTiming(state, lambda: now[0])

        def recognize(_request):
            now[0] = 1.4
            return SimpleNamespace(Result="你好")

        stt_client = Mock(SentenceRecognition=Mock(side_effect=recognize))
        frames = [frame async for frame in TencentSentenceSTT(stt_client, timing).run_stt(b"RIFF" + bytes(8100))]
        self.assertIsInstance(frames[0], TranscriptionFrame)
        self.assertEqual(state.stt_request_ms, 400)

        def synthesize(_request):
            now[0] = 1.9
            return SimpleNamespace(Audio=base64.b64encode(bytes(12_800)).decode())

        tts_client = Mock(TextToVoice=Mock(side_effect=synthesize))
        tts = TencentTTS(tts_client, timing)
        tts._sample_rate = 16_000
        tts.start_tts_usage_metrics = AsyncMock()
        frames = [frame async for frame in tts.run_tts("你好。", "test-context")]
        self.assertTrue(any(isinstance(frame, TTSAudioRawFrame) for frame in frames))
        self.assertEqual(state.tts_request_ms, 500)

    async def test_sentence_request_and_turn_cap(self):
        client = Mock()
        client.SentenceRecognition.return_value = SimpleNamespace(Result="你好")
        stt = TencentSentenceSTT(client)
        self.assertEqual(stt._settings.model, "16k_zh")
        wav = b"RIFF" + bytes(8100)
        for _ in range(MAX_TURNS):
            frames = [frame async for frame in stt.run_stt(wav)]
            self.assertEqual(len(frames), 1)
            self.assertIsInstance(frames[0], TranscriptionFrame)
            self.assertEqual(frames[0].text, "你好")
        request = client.SentenceRecognition.call_args.args[0]
        self.assertEqual(request.EngSerViceType, "16k_zh")
        self.assertEqual(request.VoiceFormat, "wav")
        self.assertEqual(request.SourceType, 1)
        self.assertEqual(request.DataLen, len(wav))
        self.assertEqual(base64.b64decode(request.Data), wav)
        frames = [frame async for frame in stt.run_stt(wav)]
        self.assertIsInstance(frames[0], ErrorFrame)
        self.assertEqual(client.SentenceRecognition.call_count, MAX_TURNS)

    async def test_stt_rejects_oversized_audio_before_request(self):
        client = Mock()
        stt = TencentSentenceSTT(client)
        frames = [frame async for frame in stt.run_stt(bytes(400_000))]
        self.assertIsInstance(frames[0], ErrorFrame)
        client.SentenceRecognition.assert_not_called()

    async def test_tts_pcm_audio_and_turn_cap(self):
        client = Mock()
        client.TextToVoice.return_value = SimpleNamespace(Audio=base64.b64encode(bytes(12_800)).decode())
        tts = TencentTTS(client)
        self.assertEqual(tts._settings.voice, "402000")
        tts._sample_rate = 16_000  # Normally set by Pipecat's StartFrame.
        tts.start_tts_usage_metrics = AsyncMock()
        for _ in range(MAX_TURNS):
            frames = [frame async for frame in tts.run_tts("你好。", "test-context")]
            self.assertTrue(any(isinstance(frame, TTSAudioRawFrame) for frame in frames))
        request = client.TextToVoice.call_args.args[0]
        self.assertEqual(request.Text, "你好。")
        self.assertEqual(request.Codec, "pcm")
        self.assertEqual(request.SampleRate, 16_000)
        self.assertEqual(request.VoiceType, 402000)
        frames = [frame async for frame in tts.run_tts("你好。", "test-context")]
        self.assertIsInstance(frames[0], ErrorFrame)
        self.assertEqual(client.TextToVoice.call_count, MAX_TURNS)


if __name__ == "__main__":
    unittest.main()
