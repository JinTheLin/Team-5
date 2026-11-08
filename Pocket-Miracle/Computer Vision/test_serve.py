"""Hardware-free integration checks: python -m unittest test_serve -v."""
import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

import serve


class FakeSource:
    status = "test source"

    def __init__(self):
        self.stale = False
        self.closed = False

    @property
    def last_frame_time(self):
        return time.time() - (10 if self.stale else 0)

    def latest(self):
        return np.zeros((100, 100, 3), dtype=np.uint8), int(time.time() * 20)

    def start(self):
        pass

    def stop(self):
        self.closed = True


class FakeModel:
    names = {0: "chair"}

    def predict(self, *args, **kwargs):
        box = SimpleNamespace(xyxy=np.array([[30, 20, 70, 90]]), cls=[0], conf=[.95])
        return [SimpleNamespace(boxes=[box])]


class FakeCloud:
    def verify(self, token):
        if token not in ("account-a", "account-b"):
            raise PermissionError("Log in first.")
        return token

    def settings(self, token):
        return {"voice_enabled": True, "warning_distance_cm": 150, "warning_confidence": .75}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.source = FakeSource()
        self.model_patch = patch("serve.load_model", return_value=FakeModel())
        self.source_patch = patch("serve.make_source", return_value=(self.source, "fake"))
        self.model_patch.start()
        self.source_patch.start()
        self.service = serve.VisionService("unused.pt", FakeCloud())
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), serve.make_handler(self.service))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.service.stop()
        if self.service.session:
            self.service.session.thread.join(2)
        self.server.shutdown()
        self.server.server_close()
        self.model_patch.stop()
        self.source_patch.stop()

    def request(self, path, body=None, origin="http://localhost:8443", token="account-a"):
        request = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json", "Origin": origin, "Authorization": f"Bearer {token}"})
        return urllib.request.urlopen(request, timeout=3)

    def wait_for(self, predicate):
        end = time.time() + 3
        while time.time() < end:
            if predicate(self.service.status()):
                return self.service.status()
            time.sleep(.03)
        self.fail(str(self.service.status()))

    def test_recognition_warning_jpeg_stop_and_stale_video(self):
        with self.request("/api/start", {"mode": "webcam", "simulated_cm": 80}) as response:
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "http://localhost:8443")
        status = self.wait_for(lambda state: state.get("last_warning") is not None)
        self.assertIn("Chair, less than one meter", status["last_warning"]["message"])
        self.assertTrue(status["last_warning"]["simulated"])
        self.assertEqual(status["detections"][0]["name"], "chair")
        self.assertIsNone(self.service.session.voice)
        with self.request("/api/frame.jpg") as response:
            self.assertTrue(response.read().startswith(b"\xff\xd8"))
        self.source.stale = True
        self.wait_for(lambda state: state["phase"] == "waiting" and not state["detections"])
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.request("/api/frame.jpg")
        self.assertEqual(failure.exception.code, 404)
        with self.request("/api/stop", {}) as response:
            self.assertEqual(json.load(response)["phase"], "stopped")
        self.assertTrue(self.source.closed)

    def test_webcam_without_distance_recognizes_but_does_not_warn(self):
        self.request("/api/start", {"mode": "webcam"}).close()
        status = self.wait_for(lambda state: state["phase"] == "live")
        self.assertEqual(status["detections"][0]["name"], "chair")
        self.assertIsNone(status["last_warning"])
        self.assertFalse(status["sonar_fresh"])

    def test_rejects_foreign_origin_and_cane_simulation(self):
        for body, origin, code in [({"mode": "webcam"}, "https://example.com", 403),
                                   ({"mode": "cane", "simulated_cm": 80}, "http://localhost:8443", 400),
                                   ({"mode": "cane", "host": "https://example.com"}, "http://localhost:8443", 400)]:
            with self.assertRaises(urllib.error.HTTPError) as failure:
                self.request("/api/start", body, origin)
            self.assertEqual(failure.exception.code, code)

    def test_model_failure_is_reported(self):
        with patch("serve.load_model", side_effect=RuntimeError("model unavailable")):
            self.request("/api/start", {"mode": "webcam"}).close()
            state = self.wait_for(lambda state: state["phase"] == "error")
            self.assertIn("model unavailable", state["detail"])

    def test_accounts_cannot_read_or_stop_each_others_camera(self):
        self.request("/api/start", {"mode": "webcam"}).close()
        self.wait_for(lambda state: state["phase"] == "live")
        with self.request("/api/status", token="account-b") as response:
            state = json.load(response)
            self.assertEqual(state["phase"], "idle")
            self.assertEqual(state["detections"], [])
            self.assertIsNone(state["session_id"])
            self.assertTrue(state["shared_busy"])
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.request("/api/frame.jpg", token="account-b")
        self.assertEqual(failure.exception.code, 404)
        self.request("/api/stop", {}, token="account-b").close()
        self.assertFalse(self.service.session.stop_event.is_set())
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.request("/api/start", {"mode": "webcam"}, token="account-b")
        self.assertEqual(failure.exception.code, 400)

    def test_missing_login_rejected(self):
        for path, body in [("/api/status", None), ("/api/frame.jpg", None), ("/api/start", {"mode": "webcam"})]:
            with self.assertRaises(urllib.error.HTTPError) as failure:
                self.request(path, body, token="")
            self.assertEqual(failure.exception.code, 401)


if __name__ == "__main__":
    unittest.main()
