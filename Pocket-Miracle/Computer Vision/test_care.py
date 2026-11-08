"""Caretaker link, SOS and live-view rules: python -m unittest test_care -v."""
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import care
import serve
from care import Care
from test_serve import FakeCloud, FakeModel, FakeSource


class CareRules(unittest.TestCase):
    def setUp(self):
        self.care = Care()

    def linked(self):
        self.care.link("helper", self.care.create_code("alex")["code"])

    def test_code_links_once_and_not_to_yourself(self):
        code = self.care.create_code("alex")["code"]
        with self.assertRaises(ValueError):
            self.care.link("alex", code)
        self.assertEqual(self.care.link("helper", code)["id"], "alex")
        with self.assertRaises(ValueError):
            self.care.link("other", code)
        self.assertEqual(self.care.caretakers("alex"), ["helper"])

    def test_new_code_replaces_old_one(self):
        old = self.care.create_code("alex")["code"]
        new = self.care.create_code("alex")["code"]
        if old != new:
            with self.assertRaises(ValueError):
                self.care.link("helper", old)
        self.care.link("helper", new)

    def test_expired_code_rejected(self):
        code = self.care.create_code("alex")["code"]
        with patch("care.time.time", return_value=time.time() + care.CODE_SECONDS + 1):
            with self.assertRaises(ValueError):
                self.care.link("helper", code)

    def test_wrong_codes_lock_out(self):
        code = self.care.create_code("alex")["code"]
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(care.MAX_FAILED_CODES):
            with self.assertRaises(ValueError):
                self.care.link("helper", wrong)
        with self.assertRaisesRegex(ValueError, "Too many"):
            self.care.link("helper", code)  # even the right code, until the lockout ends

    def test_camera_needs_approval(self):
        self.linked()
        self.assertIsNone(self.care.can_watch("helper"))
        self.care.request_live("helper")
        self.assertEqual(self.care.user_view("alex")["live"]["state"], "requested")
        self.assertIsNone(self.care.can_watch("helper"))
        self.care.respond("alex", False)
        self.assertIsNone(self.care.user_view("alex")["live"])
        self.care.request_live("helper")
        self.care.respond("alex", True)
        self.assertEqual(self.care.can_watch("helper"), "alex")

    def test_live_view_times_out(self):
        self.linked()
        self.care.request_live("helper")
        self.care.respond("alex", True)
        with patch("care.time.time", return_value=time.time() + care.LIVE_SECONDS + 1):
            self.assertIsNone(self.care.can_watch("helper"))
            self.assertIsNone(self.care.user_view("alex")["live"])

    def test_either_side_ends_live_view(self):
        self.linked()
        for ender in ("alex", "helper"):
            self.care.request_live("helper")
            self.care.respond("alex", True)
            self.care.end_live(ender)
            self.assertIsNone(self.care.can_watch("helper"))

    def test_sos_alerts_and_starts_live_view(self):
        self.linked()
        alert = self.care.sos("alex", {"lat": 33.95, "lng": -83.37, "accuracy": 12})
        self.assertEqual(alert["delivered_to"], 1)
        view = self.care.caretaker_view("helper", lambda user: {"phase": "live", "frame_id": 4})
        self.assertEqual(view["alerts"][0]["location"]["lat"], 33.95)
        self.assertEqual(view["live"]["reason"], "sos")
        self.assertEqual(view["camera"]["frame_id"], 4)

    def test_sos_without_caretaker_is_recorded_not_shared(self):
        alert = self.care.sos("alex")
        self.assertEqual(alert["delivered_to"], 0)
        self.assertIsNone(self.care.user_view("alex")["live"])

    def test_bad_location_rejected(self):
        for location in ({"lat": 91, "lng": 0}, {"lat": "x", "lng": 0}, {"lng": 0}, "here", {"lat": float("nan"), "lng": 0}):
            with self.assertRaises(ValueError):
                self.care.sos("alex", location)

    def test_no_camera_details_without_live_view(self):
        self.linked()
        view = self.care.caretaker_view("helper", lambda user: {"phase": "live", "detections": [{"name": "door"}]})
        self.assertTrue(view["detection_running"])
        self.assertNotIn("camera", view)

    def test_unlink_ends_live_view(self):
        self.linked()
        self.care.request_live("helper")
        self.care.respond("alex", True)
        self.care.unlink("alex", "helper")
        self.assertIsNone(self.care.can_watch("helper"))
        self.assertEqual(self.care.caretaker_view("helper", lambda u: {}), {"linked": None})
        with self.assertRaises(ValueError):
            self.care.unlink("alex", "stranger")

    def test_two_caretakers_racing_for_one_code(self):
        code = self.care.create_code("alex")["code"]
        wins, start = [], threading.Barrier(10)

        def attempt(name):
            start.wait()
            try:
                self.care.link(name, code)
                wins.append(name)
            except ValueError:
                pass
        threads = [threading.Thread(target=attempt, args=(f"helper-{i}",)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(wins), 1)
        self.assertEqual(self.care.caretakers("alex"), wins)

    def test_alert_log_is_bounded(self):
        self.linked()
        for _ in range(50):
            self.care.sos("alex")
        self.assertEqual(len(self.care.caretaker_view("helper", lambda u: {})["alerts"]), care.KEEP_ALERTS)
        self.assertEqual(len(self.care.user_view("alex")["alerts"]), 5)

    def test_request_while_already_sharing_keeps_the_view(self):
        self.linked()
        self.care.sos("alex")
        self.care.request_live("helper")
        self.assertEqual(self.care.user_view("alex")["live"]["state"], "active")

    def test_links_survive_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "links.json"
            first = Care(path)
            first.link("helper", first.create_code("alex")["code"])
            self.assertEqual(Care(path).caretakers("alex"), ["helper"])


class CareOverHttp(unittest.TestCase):
    """account-a is the cane user, account-b the caretaker (FakeCloud tokens)."""

    def setUp(self):
        self.patches = [patch("serve.load_model", return_value=FakeModel()),
                        patch("serve.make_source", return_value=(FakeSource(), "fake"))]
        for p in self.patches:
            p.start()
        self.service = serve.VisionService(["unused.pt"], FakeCloud())
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), serve.make_handler(self.service))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.service.stop()
        if self.service.session:
            self.service.session.thread.join(2)
        self.server.shutdown()
        self.server.server_close()
        for p in self.patches:
            p.stop()

    def call(self, path, body=None, token="account-a"):
        request = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", "Origin": "http://localhost:8443",
                                                  "Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.read() if path.endswith(".jpg") else json.loads(response.read())

    def status_code(self, path, body=None, token="account-a"):
        try:
            self.call(path, body, token)
            return 200
        except urllib.error.HTTPError as error:
            return error.code

    def test_full_caretaker_flow(self):
        self.call("/api/start", {"mode": "webcam"})
        end = time.time() + 3
        while self.service.status("account-a")["phase"] != "live" and time.time() < end:
            time.sleep(.03)

        code = self.call("/api/care/code", {})["code"]
        self.assertEqual(self.status_code("/api/care/link", {"code": "nope"}, "account-b"), 400)
        self.assertEqual(self.call("/api/care/link", {"code": code}, "account-b")["linked"]["id"], "account-a")
        self.assertEqual(self.call("/api/status")["care"]["caretakers"][0]["id"], "account-b")

        # No camera until the user approves.
        self.assertEqual(self.status_code("/api/care/frame.jpg", token="account-b"), 404)
        self.call("/api/care/live/request", {}, "account-b")
        self.assertEqual(self.call("/api/status")["care"]["live"]["state"], "requested")
        self.assertEqual(self.status_code("/api/care/frame.jpg", token="account-b"), 404)
        self.call("/api/care/live/respond", {"approve": True})
        self.assertTrue(self.call("/api/care/frame.jpg", token="account-b").startswith(b"\xff\xd8"))
        self.assertEqual(self.call("/api/care/status", token="account-b")["camera"]["detections"][0]["name"], "chair")

        # The user ends sharing; the frame goes away again.
        self.call("/api/care/live/end", {})
        self.assertEqual(self.status_code("/api/care/frame.jpg", token="account-b"), 404)

        # SOS reaches the caretaker with location and reopens the view.
        self.call("/api/care/sos", {"location": {"lat": 33.95, "lng": -83.37}})
        view = self.call("/api/care/status", token="account-b")
        self.assertEqual(view["alerts"][0]["kind"], "sos")
        self.assertEqual(view["live"]["state"], "active")

        # Logging out (the app calls /api/disconnect) ends sharing.
        self.call("/api/disconnect", {})
        self.assertIsNone(self.call("/api/care/status", token="account-b")["live"])

        self.call("/api/care/unlink", {}, "account-b")
        self.assertIsNone(self.call("/api/care/status", token="account-b")["linked"])

    def test_requires_login_and_valid_input(self):
        self.assertEqual(self.status_code("/api/care/code", {}, "nobody"), 401)
        self.assertEqual(self.status_code("/api/care/status", token="nobody"), 401)
        self.assertEqual(self.status_code("/api/care/live/respond", {"approve": True}), 400)
        self.assertEqual(self.status_code("/api/care/sos", {"location": {"lat": 200, "lng": 0}}), 400)
        self.assertEqual(self.status_code("/api/care/live/request", {}, "account-b"), 400)
        for body in ({"code": None}, {"code": 123456}, {"code": ["1"]}, {"location": "here"}, {"location": None},
                     {"caretaker_id": "nobody"}, {"approve": "yes"}):
            for path in ("link", "sos", "unlink", "live/respond"):
                self.assertIn(self.status_code(f"/api/care/{path}", body), (200, 400), f"{path} {body}")
        self.assertEqual(self.status_code("/api/care/nope", {}), 404)


if __name__ == "__main__":
    unittest.main()
