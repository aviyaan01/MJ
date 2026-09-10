import os
import unittest
from fastapi.testclient import TestClient

from dashboard.server import DashboardServer


class TestDashboardRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["DASHBOARD_PIN"] = "123456"
        cls.server = DashboardServer()
        cls.client = TestClient(cls.server.app)

    def test_login_page_renders(self):
        res = self.client.get("/login")
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/html", res.headers.get("content-type", ""))

    def test_index_renders(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/html", res.headers.get("content-type", ""))

    def test_crypto_static_endpoint(self):
        res = self.client.get("/static/crypto.js")
        self.assertIn(res.status_code, (200, 404))

    def test_login_invalid_pin(self):
        res = self.client.post("/login", json={"pin": "WRONG_PIN"})
        self.assertEqual(res.status_code, 401)
        data = res.json()
        self.assertFalse(data.get("ok"))

    def test_login_master_pin(self):
        res = self.client.post("/login", json={"pin": "123456"})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data.get("ok"))
        self.assertTrue("token" in data)

    def test_settings_endpoint_authorized(self):
        # First login to get bearer token
        login_res = self.client.post("/login", json={"pin": "123456"})
        token = login_res.json()["token"]

        headers = {"Authorization": f"Bearer {token}"}
        res = self.client.get("/api/settings", headers=headers)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data.get("ok"))
        self.assertIn("assistant_name", data.get("data", {}))


if __name__ == "__main__":
    unittest.main()
