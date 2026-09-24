"""The private AI API rejects direct non-loopback clients even if misbound."""

import unittest

from httpx import ASGITransport, AsyncClient

from server import app


class LoopbackGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_loopback_health_is_available(self):
        async with AsyncClient(transport=ASGITransport(app=app, client=("127.0.0.1", 12345)),
                               base_url="http://127.0.0.1") as client:
            response = await client.get("/healthz")
        self.assertEqual(response.status_code, 200)

    async def test_non_loopback_cannot_reach_offer_or_ice(self):
        async with AsyncClient(transport=ASGITransport(app=app, client=("198.51.100.10", 12345)),
                               base_url="http://198.51.100.10") as client:
            for path in ("/healthz", "/api/private-ice", "/api/offer"):
                response = await client.get(path)
                self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
