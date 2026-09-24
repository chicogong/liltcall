"""Loopback-only Pipecat SmallWebRTC audio-path prototype for LiltCall."""

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from urllib.request import urlopen

from fastapi import FastAPI, HTTPException, Request
from loguru import logger
from starlette.responses import Response

logger.remove()
logger.add(sys.stderr, level="WARNING")  # ICE debug logs can contain private addresses.

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    ConnectionMode,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

from local_agent import build_local_pipeline
from private_ice import load_private_ice
from probe import AudioPathProbe, ProbeState
from voice_observability import VoiceState

mode = os.environ.get("LILTCALL_AI_MODE", "probe")
if mode not in {"probe", "local", "cloud", "cloud-stream"}:
    raise RuntimeError("LILTCALL_AI_MODE must be 'probe', 'local', 'cloud', or 'cloud-stream'")

ice_servers, browser_ice_servers = load_private_ice()
handler = SmallWebRTCRequestHandler(ice_servers=ice_servers, connection_mode=ConnectionMode.SINGLE)
offer_lock = asyncio.Lock()
connections: dict[str, SmallWebRTCConnection] = {}
states: dict[str, ProbeState | VoiceState] = {}
tasks: dict[str, asyncio.Task] = {}


async def run_agent(connection: SmallWebRTCConnection, state: ProbeState | VoiceState):
    try:
        transport = SmallWebRTCTransport(
            webrtc_connection=connection,
            params=TransportParams(
                audio_in_enabled=True,
                audio_in_sample_rate=16000,
                audio_out_enabled=True,
                audio_out_sample_rate=16000,
                audio_out_auto_silence=False,
            ),
        )
        if mode == "cloud":
            from cloud_agent import build_cloud_pipeline

            pipeline = build_cloud_pipeline(transport, state)
        elif mode == "cloud-stream":
            from streaming_cloud import build_stream_pipeline

            pipeline = build_stream_pipeline(transport, state)
        elif mode == "local":
            pipeline = build_local_pipeline(transport, state)
        else:
            pipeline = Pipeline([transport.input(), AudioPathProbe(state), transport.output()])
        # Browser prototype has no Pipecat app-message consumer; avoid flooding its queue.
        worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=False))
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)

        @transport.event_handler("on_client_disconnected")
        async def on_client_disconnected(_transport, _client):
            await runner.cancel()

        await runner.run()
    except Exception:
        logger.exception("Local voice agent failed; closing the peer connection")
    finally:
        await connection.disconnect()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if mode == "cloud":
        from cloud_voice_config import require_cloud_config

        require_cloud_config()
    if mode == "cloud-stream":
        from cloud_voice_config import require_stream_config

        require_stream_config()
    if mode == "local":
        from nltk.data import find

        try:
            find("tokenizers/punkt_tab/english/")
        except LookupError as error:
            raise RuntimeError(
                "NLTK punkt_tab data is missing; install it before starting local voice mode"
            ) from error
        # Fail before accepting a call if the requested model is missing. Never use cloud fallback.
        try:
            with urlopen("http://127.0.0.1:11434/api/tags", timeout=3) as response:
                model_names = {item["name"] for item in json.load(response).get("models", [])}
        except Exception as error:
            raise RuntimeError("Local Ollama is unavailable on 127.0.0.1:11434") from error
        model = os.environ.get("LILTCALL_AI_OLLAMA_MODEL", "qwen2.5:0.5b")
        if model not in model_names:
            raise RuntimeError(f"Local Ollama model '{model}' is missing; run ollama pull first")
    yield
    await handler.close()
    for task in tasks.values():
        task.cancel()
    await asyncio.gather(*tasks.values(), return_exceptions=True)
    tasks.clear()
    connections.clear()
    states.clear()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def reject_non_loopback(request: Request, call_next):
    # The AI spike is private even if someone starts Uvicorn with --host 0.0.0.0.
    # A local SSH tunnel reaches it from 127.0.0.1; no forwarded-IP header is trusted.
    if not request.client or request.client.host not in {"127.0.0.1", "::1"}:
        return Response(status_code=403)
    return await call_next(request)


@app.get("/healthz")
async def healthz():
    label = {"probe": "audio-probe", "local": "local-voice", "cloud": "cloud-voice", "cloud-stream": "cloud-stream-voice"}[mode]
    return {"status": "ok", "mode": label, "active": len(connections)}


@app.get("/api/private-ice")
async def private_ice():
    # This service must bind to loopback. A local tunnel may carry signaling;
    # the browser still needs these short-lived credentials for the media path.
    return {"iceServers": browser_ice_servers}


@app.post("/api/offer")
async def offer(request: SmallWebRTCRequest):
    if request.type != "offer" or request.pc_id or len(request.sdp) > 64_000:
        raise HTTPException(status_code=400, detail="Invalid offer")

    async def start_agent(connection: SmallWebRTCConnection):
        peer_id = connection.pc_id
        state = VoiceState() if mode in {"local", "cloud", "cloud-stream"} else ProbeState()
        connections[peer_id] = connection
        states[peer_id] = state

        @connection.event_handler("closed")
        async def on_closed(_connection):
            connections.pop(peer_id, None)
            states.pop(peer_id, None)

        task = asyncio.create_task(run_agent(connection, state))
        tasks[peer_id] = task
        task.add_done_callback(lambda _task: tasks.pop(peer_id, None))

    # Serialize admission: the upstream SINGLE check alone can race on concurrent offers.
    async with offer_lock:
        return await handler.handle_web_request(request, start_agent)


@app.patch("/api/offer")
async def ice_candidate(request: SmallWebRTCPatchRequest):
    await handler.handle_patch_request(request)
    return {"status": "ok"}


@app.get("/api/metrics/{peer_id}")
async def metrics(peer_id: str):
    state = states.get(peer_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    return state


@app.delete("/api/offer/{peer_id}")
async def hang_up(peer_id: str):
    connection = connections.get(peer_id)
    if connection is not None:
        await connection.disconnect()
    return {"status": "closed"}
