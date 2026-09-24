"""Optional ICE configuration for a loopback-only private AI test."""

import json
import os

from pipecat.transports.smallwebrtc.connection import IceServer


def _parse_ice(raw: str) -> list[dict]:
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Invalid private ICE JSON") from error
    if not isinstance(config, list) or not 1 <= len(config) <= 3:
        raise RuntimeError("Private ICE must contain 1–3 servers")
    for item in config:
        if not isinstance(item, dict) or set(item) - {"urls", "username", "credential"}:
            raise RuntimeError("Invalid private ICE server")
        urls = item.get("urls")
        urls = [urls] if isinstance(urls, str) else urls
        if not isinstance(urls, list) or not urls or not all(
            isinstance(url, str) and url.startswith(("stun:", "turn:", "turns:")) for url in urls
        ):
            raise RuntimeError("Invalid private ICE URL")
        if any(url.startswith(("turn:", "turns:")) for url in urls):
            if not item.get("username") or not item.get("credential"):
                raise RuntimeError("Private TURN needs temporary credentials")
        if any(not isinstance(item.get(field, ""), str) for field in ("username", "credential")):
            raise RuntimeError("Invalid private ICE credentials")
    return config


def load_private_ice() -> tuple[list[IceServer], list[dict]]:
    browser_raw = os.environ.get("LILTCALL_AI_PRIVATE_ICE_JSON")
    server_raw = os.environ.get("LILTCALL_AI_SERVER_ICE_JSON")
    if not browser_raw and not server_raw:
        return [], []
    if not browser_raw or not server_raw:
        raise RuntimeError("Private remote ICE needs separate browser and server credentials")
    browser = _parse_ice(browser_raw)
    server = _parse_ice(server_raw)
    browser_users = {item.get("username") for item in browser}
    server_users = {item.get("username") for item in server}
    if (browser_users - {None}) & (server_users - {None}):
        raise RuntimeError("Private remote ICE peers must use distinct TURN users")
    return [IceServer(**item) for item in server], browser
