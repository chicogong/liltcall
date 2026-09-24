"""One-shot, real-provider smoke for an explicitly opted-in private environment.

Exactly two short Tencent TTS calls, one Tencent sentence ASR call, and one
SiliconFlow chat call. No retries, input recording, or credential logging.
"""

import base64
import io
import json
import os
import time
import uuid
import wave

from cloud_agent import make_tencent_clients
from cloud_voice_config import MAX_TTS_CHARS, SAMPLE_RATE, require_cloud_config


def synth(client, text: str) -> bytes:
    from tencentcloud.tts.v20190823 import models

    request = models.TextToVoiceRequest()
    request.Text = text.strip()[:MAX_TTS_CHARS]
    request.SessionId = uuid.uuid4().hex
    request.VoiceType = 402000
    request.PrimaryLanguage = 1
    request.SampleRate = SAMPLE_RATE
    request.Codec = "pcm"
    pcm = base64.b64decode(client.TextToVoice(request).Audio, validate=True)
    if len(pcm) < SAMPLE_RATE or len(pcm) % 2:
        raise ValueError("Invalid TTS PCM response")
    return pcm


def main() -> None:
    if os.environ.get("LILTCALL_AI_SMOKE_ONE_SHOT") != "1":
        raise RuntimeError("Set LILTCALL_AI_SMOKE_ONE_SHOT=1 for the bounded provider test")
    secret_id, secret_key, silicon_key = require_cloud_config()
    asr, tts = make_tencent_clients(secret_id, secret_key)

    def timed(call):
        start = time.perf_counter()
        value = call()
        return value, round((time.perf_counter() - start) * 1000)

    seed_pcm, seed_ms = timed(lambda: synth(tts, "你好，请用一句话介绍自己。"))
    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(seed_pcm)
    wav_data = wav_buffer.getvalue()

    def transcribe() -> str:
        from tencentcloud.asr.v20190614 import models

        request = models.SentenceRecognitionRequest()
        request.EngSerViceType = "16k_zh"
        request.SourceType = 1
        request.VoiceFormat = "wav"
        request.Data = base64.b64encode(wav_data).decode("ascii")
        request.DataLen = len(wav_data)
        return asr.SentenceRecognition(request).Result.strip()

    transcript, asr_ms = timed(transcribe)
    if not transcript:
        raise ValueError("Empty ASR result")

    def answer() -> str:
        from openai import OpenAI

        client = OpenAI(
            api_key=silicon_key,
            base_url="https://api.siliconflow.cn/v1",
            timeout=8.0,
            max_retries=0,
        )
        response = client.chat.completions.create(
            model="Qwen/Qwen2.5-7B-Instruct",
            max_tokens=80,
            messages=[
                {"role": "system", "content": "你是语音助手。用简短的中文一句话回答，不要 Markdown。"},
                {"role": "user", "content": transcript},
            ],
        )
        return (response.choices[0].message.content or "").strip()[:MAX_TTS_CHARS]

    reply, llm_ms = timed(answer)
    if not reply:
        raise ValueError("Empty LLM reply")
    output_pcm, reply_ms = timed(lambda: synth(tts, reply))
    print(json.dumps({
        "result": "passed",
        "tts_calls": 2,
        "asr_calls": 1,
        "llm_calls": 1,
        "seed_tts_ms": seed_ms,
        "asr_ms": asr_ms,
        "llm_ms": llm_ms,
        "reply_tts_ms": reply_ms,
        "reply_audio_ms": round(len(output_pcm) / (SAMPLE_RATE * 2) * 1000),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = getattr(error, "get_code", lambda: None)()
        print(json.dumps({"result": "failed", "error_type": type(error).__name__, "error_code": code}))
        raise SystemExit(1)
