"""Private ICE configuration tests; no network or real TURN credentials."""

import json
import os
import unittest
from unittest.mock import patch

from private_ice import load_private_ice


class PrivateIceTests(unittest.TestCase):
    def test_loopback_default_needs_no_ice_servers(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(load_private_ice(), ([], []))

    def test_temporary_turn_credentials_are_distinct_per_peer(self):
        config = [{"urls": ["turn:turn.example.org:3478?transport=udp"],
                   "username": "browser", "credential": "temporary-browser-password"}]
        server_config = [{"urls": ["turn:127.0.0.1:3478?transport=udp"],
                          "username": "server", "credential": "temporary-server-password"}]
        with patch.dict(os.environ, {"LILTCALL_AI_PRIVATE_ICE_JSON": json.dumps(config),
                                  "LILTCALL_AI_SERVER_ICE_JSON": json.dumps(server_config)}):
            server, browser = load_private_ice()
        self.assertEqual(browser, config)
        self.assertEqual(server[0].username, "server")
        self.assertEqual(server[0].credential, "temporary-server-password")

    def test_shared_turn_username_fails_closed(self):
        config = '[{"urls":"turn:turn.example.org:3478","username":"same","credential":"temporary"}]'
        with patch.dict(os.environ, {"LILTCALL_AI_PRIVATE_ICE_JSON": config,
                                  "LILTCALL_AI_SERVER_ICE_JSON": config}):
            with self.assertRaisesRegex(RuntimeError, "distinct TURN users"):
                load_private_ice()

    def test_turn_without_credentials_fails_closed(self):
        with patch.dict(os.environ, {"LILTCALL_AI_PRIVATE_ICE_JSON": '[{"urls":"turn:turn.example.org:3478"}]',
                                  "LILTCALL_AI_SERVER_ICE_JSON": '[{"urls":"stun:stun.example.org:3478"}]'}):
            with self.assertRaisesRegex(RuntimeError, "temporary credentials"):
                load_private_ice()

    def test_invalid_ice_fails_closed(self):
        with patch.dict(os.environ, {"LILTCALL_AI_PRIVATE_ICE_JSON": '[{"urls":"https://example.org"}]',
                                  "LILTCALL_AI_SERVER_ICE_JSON": '[{"urls":"stun:stun.example.org:3478"}]'}):
            with self.assertRaisesRegex(RuntimeError, "Invalid private ICE URL"):
                load_private_ice()


if __name__ == "__main__":
    unittest.main()
