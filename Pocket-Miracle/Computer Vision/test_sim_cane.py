"""Simulated cane + laptop, no hardware: python -m unittest test_sim_cane -v.

The end-to-end test runs the real YOLO model (downloads yolo11n.pt once).
"""
import json
import random
import shutil
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import serve
import sim_cane
from test_serve import FakeCloud


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


class AddressTests(unittest.TestCase):
    def test_cane_address_with_and_without_port(self):
        self.assertEqual(serve.validate_config({"mode": "cane", "host": "172.20.10.3"})["host"], "172.20.10.3")
        self.assertEqual(serve.validate_config({"mode": "cane", "host": " 127.0.0.1:8080 "})["host"], "127.0.0.1:8080")
        for bad in ("127.0.0.1:0", "127.0.0.1:abc", "127.0.0.1:65535", "8.8.8.8:80", "cane.local"):
            with self.assertRaises(ValueError, msg=bad):
                serve.validate_config({"mode": "cane", "host": bad})


class SimCaneContract(unittest.TestCase):
    """Same replies as the firmware (app_httpd.cpp)."""

    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.mkdtemp()
        import numpy as np, cv2
        cv2.imwrite(str(Path(cls.folder) / "blank.jpg"), np.zeros((240, 320, 3), np.uint8))
        cls.port = random.randint(20000, 40000)
        cls.cane, cls.stop = sim_cane.start(cls.folder, cls.port, cm=85.25)
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.stop()
        shutil.rmtree(cls.folder)

    def setUp(self):
        get(f"{self.base}/sim?on=1&cm=85.25")

    def test_distance(self):
        self.assertEqual(json.loads(get(f"{self.base}/distance")[1]), {"on": True, "cm": 85.2})
        get(f"{self.base}/sim?cm=none")
        self.assertEqual(json.loads(get(f"{self.base}/distance")[1]), {"on": True, "cm": None})
        get(f"{self.base}/sim?on=0&cm=50")
        self.assertEqual(json.loads(get(f"{self.base}/distance")[1]), {"on": False, "cm": None})

    def test_warn_replies(self):
        self.assertEqual(get(f"{self.base}/warn?msg=chair,0.9"), (200, b"ok\n"))
        self.assertEqual(get(f"{self.base}/warn?msg=stairs"), (200, b"ok\n"))
        self.assertEqual(get(f"{self.base}/warn?msg=spaceship,1.0")[0], 400)
        self.assertEqual(get(f"{self.base}/warn")[0], 400)
        get(f"{self.base}/sim?on=0")
        self.assertEqual(get(f"{self.base}/warn?msg=chair,0.9"), (200, b"ignored: cane is off\n"))
        said = [s["sentence"] for s in self.cane.state()["spoken"]]
        self.assertIn("Chair, less than one meter. Caution.", said)
        self.assertIn("Stairs ahead. Caution.", said)

    def test_beeper_matches_firmware_thresholds(self):
        self.assertEqual(sim_cane.beeper(150, True), "silent")
        self.assertEqual(sim_cane.beeper(25, True), "solid tone")
        self.assertEqual(sim_cane.beeper(120, True), "beeping every 800 ms")
        self.assertEqual(sim_cane.beeper(25, False), "silent")

    def test_stream_sends_jpegs(self):
        end = time.time() + 3
        while self.cane is not None and time.time() < end:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port + 1}/stream", timeout=3) as response:
                chunk = response.read(4096)
            if b"\xff\xd8" in chunk:
                return
            time.sleep(.1)
        self.fail("no JPEG on the stream")


class EndToEnd(unittest.TestCase):
    """Real model on simulated cane video: the cane should speak the warning."""

    def test_cane_speaks_what_the_laptop_sees(self):
        try:
            import ultralytics
        except ImportError:
            self.skipTest("ultralytics not installed")
        folder = tempfile.mkdtemp()
        shutil.copy(Path(ultralytics.__file__).parent / "assets/bus.jpg", folder)
        port = random.randint(40001, 60000)
        cane, stop_cane = sim_cane.start(folder, port, cm=80)

        class Cloud(FakeCloud):  # a user who lowered "warning confidence" to 60% in Settings
            def settings(self, token):
                return {**super().settings(token), "warning_confidence": .6}
        service = serve.VisionService(["yolo11n.pt"], Cloud())
        try:
            service.start({"mode": "cane", "host": f"127.0.0.1:{port}"}, "account-a", "account-a")
            end = time.time() + 60
            while not cane.state()["spoken"] and time.time() < end:
                time.sleep(.2)
            status = service.status("account-a")
            self.assertTrue(cane.state()["spoken"], status)
            self.assertEqual(cane.state()["spoken"][0]["msg"], "bus,0.8")
            self.assertEqual(status["phase"], "live")
            self.assertEqual(status["sonar_cm"], 80)
            self.assertIn("bus", [d["name"] for d in status["detections"]])

            # Cane switched off: the laptop stops warning.
            get(f"http://127.0.0.1:{port}/sim?on=0")
            time.sleep(1.5)
            self.assertIs(service.status("account-a")["cane_on"], False)
        finally:
            service.stop()
            if service.session:
                service.session.thread.join(6)
            stop_cane()
            shutil.rmtree(folder)


if __name__ == "__main__":
    unittest.main()
