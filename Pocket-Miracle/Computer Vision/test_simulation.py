"""Walk simulations: real YOLO + real warning rules + simulated cane.
python -m unittest test_simulation -v   (about a minute; downloads yolo11n.pt once)
"""
import os
import random
import shutil
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

import numpy as np
import cv2

import serve
import sim_cane
from test_serve import FakeCloud

HERE = Path(__file__).resolve().parent
CUSTOM = HERE / "models/door_stairs.pt"


class Cloud(FakeCloud):
    def settings(self, token):  # the bus photo scores ~0.68, so test with a 60% warning confidence
        return {**super().settings(token), "warning_confidence": .6}


class Walk(unittest.TestCase):
    def setUp(self):
        try:
            import ultralytics
        except ImportError:
            self.skipTest("ultralytics not installed")
        self.folder = Path(tempfile.mkdtemp())
        self.bus = cv2.imread(str(Path(ultralytics.__file__).parent / "assets/bus.jpg"))
        self.blank = np.full((480, 640, 3), 128, np.uint8)
        self.show(self.bus)
        self.port = random.randint(20000, 60000)
        self.cane, self.stop_cane = sim_cane.start(str(self.folder), self.port, cm=300, seconds_per_image=.1)
        models = ["yolo11n.pt"] + ([str(CUSTOM)] if CUSTOM.exists() else [])
        self.service = serve.VisionService(models, Cloud())
        self.service.start({"mode": "cane", "host": f"127.0.0.1:{self.port}"}, "account-a", "account-a")
        self.wait(lambda: self.status()["phase"] == "live" and self.status()["sonar_cm"] == 300, 60, "never went live")

    def tearDown(self):
        if not hasattr(self, "service"):
            return
        self.service.stop()
        if self.service.session:
            self.service.session.thread.join(6)
        self.stop_cane()
        shutil.rmtree(self.folder)

    def show(self, image):
        tmp = self.folder / "next.tmp.jpg"
        cv2.imwrite(str(tmp), image)
        os.replace(tmp, self.folder / "scene.jpg")

    def sim(self, query):
        urllib.request.urlopen(f"http://127.0.0.1:{self.port}/sim?{query}", timeout=2).read()

    def status(self):
        return self.service.status("account-a")

    def spoken(self):
        return [s["msg"] for s in self.cane.state()["spoken"]]

    def wait(self, predicate, timeout=10, message="timed out"):
        end = time.time() + timeout
        while time.time() < end:
            if predicate():
                return
            time.sleep(.05)
        self.fail(f"{message}: {self.status().get('detail')} spoken={self.spoken()}")

    def test_walking_toward_an_obstacle(self):
        time.sleep(1.5)
        self.assertEqual(self.spoken(), [], "warned while the obstacle was still 3 m away")

        started = time.time()
        self.sim("cm=140")
        self.wait(lambda: self.spoken() == ["bus,1.4"])
        latency = time.time() - started
        self.assertEqual(self.cane.state()["spoken"][0]["sentence"], "Bus, one meter. Caution.")

        self.sim("cm=120")  # same "one meter" band: say nothing new
        time.sleep(1.5)
        self.assertEqual(self.spoken(), ["bus,1.4"])

        self.sim("cm=90")   # closer band: say it again
        self.wait(lambda: self.spoken() == ["bus,1.4", "bus,0.9"])
        self.sim("cm=60")
        time.sleep(1.5)
        self.assertEqual(len(self.spoken()), 2, "repeated inside the same band")

        self.show(self.blank)  # walk past it; after 3 s it counts as new
        time.sleep(4.5)
        self.assertEqual(len(self.spoken()), 2)
        self.show(self.bus)
        self.wait(lambda: len(self.spoken()) == 3)
        self.assertEqual(self.spoken()[-1], "bus,0.6")
        self.assertEqual(self.cane.state()["warn_requests"], 3, "laptop sent extra requests to the cane")
        print(f"\n    obstacle in range -> cane speaks: {latency * 1000:.0f} ms "
              f"(inference {self.status()['inference_ms']} ms/frame)")
        self.assertLess(latency, 2.0)

    def test_switched_off_cane_gets_no_warnings(self):
        self.sim("on=0&cm=80")
        self.wait(lambda: self.status()["cane_on"] is False)
        time.sleep(2)
        self.assertEqual(self.cane.state()["warn_requests"], 0)
        self.sim("on=1")
        self.wait(lambda: self.spoken() == ["bus,0.8"])

    def test_nothing_in_sonar_range_means_no_warning(self):
        self.sim("cm=none")
        time.sleep(2)
        self.assertEqual(self.cane.state()["warn_requests"], 0)
        self.assertIn("nothing in range", self.status()["detail"])

    def test_cane_drops_off_wifi_and_comes_back(self):
        self.stop_cane()
        self.wait(lambda: self.status()["phase"] == "waiting", 8, "did not notice the lost cane")
        self.assertEqual(self.status()["detections"], [])
        self.cane, self.stop_cane = sim_cane.start(str(self.folder), self.port, cm=80, seconds_per_image=.1)
        self.wait(lambda: self.status()["phase"] == "live", 15, "did not reconnect")
        self.wait(lambda: self.spoken() == ["bus,0.8"], 10)

    @unittest.skipUnless(CUSTOM.exists(), "custom door/stairs model not installed")
    def test_stairs_warn_without_a_sonar_echo(self):
        stairs = cv2.imread(str(HERE / "test_images/stairs.jpg"))
        self.assertIsNotNone(stairs, "test_images/stairs.jpg missing")
        self.sim("cm=none")  # a drop gives no echo
        self.show(stairs)
        self.wait(lambda: "stairs" in self.spoken(), 15, "stairs not announced")
        self.assertEqual(self.cane.state()["spoken"][-1]["sentence"], "Stairs ahead. Caution.")

    @unittest.skipUnless(CUSTOM.exists(), "custom door/stairs model not installed")
    def test_door_detected_and_warned_with_distance(self):
        door = cv2.imread(str(HERE / "test_images/door.jpg"))
        self.assertIsNotNone(door, "test_images/door.jpg missing")
        self.sim("cm=90")
        self.show(door)
        self.wait(lambda: "door,0.9" in self.spoken(), 15, "door not announced")


if __name__ == "__main__":
    unittest.main()
