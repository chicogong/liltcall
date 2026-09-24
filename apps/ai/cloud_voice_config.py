"""Shared bounded cost gates for opt-in Tencent/SiliconFlow voice modes."""

import os

SAMPLE_RATE = 16_000
_max_turns = os.environ.get("LILTCALL_AI_CLOUD_MAX_TURNS", "3")
if _max_turns not in {"1", "2", "3"}:
    raise RuntimeError("LILTCALL_AI_CLOUD_MAX_TURNS must be 1, 2, or 3")
MAX_TURNS = int(_max_turns)
MAX_SEGMENT_BYTES = SAMPLE_RATE * 2 * 10 + 44  # Ten seconds of 16-bit mono WAV.
MAX_TTS_CHARS = 120


def require_cloud_config() -> tuple[str, str, str]:
    if os.environ.get("LILTCALL_AI_CLOUD_ALLOW_BILLING") != "1":
        raise RuntimeError("Cloud voice calls are disabled until LILTCALL_AI_CLOUD_ALLOW_BILLING=1")
    names = ("TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "SILICONFLOW_API_KEY")
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise RuntimeError("Missing cloud credentials: " + ", ".join(missing))
    return tuple(os.environ[name] for name in names)


def require_stream_config() -> tuple[str, str, str, str]:
    secret_id, secret_key, silicon_key = require_cloud_config()
    if os.environ.get("LILTCALL_AI_REALTIME_ALLOW_BILLING") != "1":
        raise RuntimeError("Realtime ASR/TTS disabled until LILTCALL_AI_REALTIME_ALLOW_BILLING=1")
    app_id = os.environ.get("TENCENTCLOUD_APP_ID", "")
    if not app_id.isascii() or not app_id.isdecimal() or not 6 <= len(app_id) <= 12:
        raise RuntimeError("TENCENTCLOUD_APP_ID must be a 6-12 digit account AppID")
    return app_id, secret_id, secret_key, silicon_key
