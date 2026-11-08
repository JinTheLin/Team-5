"""Simulated smart cane: test the app and laptop without the hardware.

Speaks the same HTTP as the real cane (app_httpd.cpp):
  GET  :PORT/distance          {"on": true, "cm": 85.3}
  GET  :PORT/warn?msg=chair,0.9 "ok" / "ignored: cane is off" / 400
  GET  :PORT+1/stream           MJPEG video

Plus controls the real cane doesn't have:
  GET  :PORT/sim?cm=80          move the pretend obstacle (cm=none: nothing in range)
  GET  :PORT/sim?on=0           switch the cane off (on=1: back on)
  GET  :PORT/sim                current state, beeper, and every warning it has said

Run it, then in the app's Camera tab choose "Physical cane" with address 127.0.0.1:8080.
  python sim_cane.py                      # laptop webcam as the cane camera
  python sim_cane.py --source photos/     # loop through pictures (e.g. doors, stairs)
  python sim_cane.py --source walk.mp4 --say
"""
import argparse
import json
import math
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2

from cane_logic import Alert

HERE = Path(__file__).resolve().parent
CLIPS = {p.stem for p in (HERE.parent / "Hardware/esp32/voice/clips").glob("*.wav")}
# Same tuning as CameraWebServer.ino
ALERT_START_CM, DANGER_CM = 120.0, 30.0
SLOWEST_GAP_MS, FASTEST_GAP_MS = 800, 60


def beeper(cm, on):
    """What the real cane's speaker would be doing at this distance."""
    if not on or cm is None or cm > ALERT_START_CM:
        return "silent"
    if cm <= DANGER_CM:
        return "solid tone"
    closeness = (ALERT_START_CM - cm) / (ALERT_START_CM - DANGER_CM)
    return f"beeping every {SLOWEST_GAP_MS - closeness * (SLOWEST_GAP_MS - FASTEST_GAP_MS):.0f} ms"


def parse_warning(msg):
    """'chair,0.9' or 'stairs' -> Alert, or None if the cane has no clip for it (firmware: 400)."""
    word, _, meters = msg.partition(",")
    if word not in CLIPS:
        return None
    if not meters:
        return Alert(word, None)
    try:
        value = float(meters)
    except ValueError:
        return None
    return Alert(word, value) if math.isfinite(value) and value >= 0 else None


class Frames(threading.Thread):
    """Latest JPEG from a webcam, a video file, or a folder of pictures."""

    def __init__(self, source, fps=10, seconds_per_image=4.0):
        super().__init__(daemon=True)
        self.source, self.fps, self.seconds_per_image = source, fps, seconds_per_image
        self.jpeg = None
        self.lock = threading.Lock()
        self.stopped = threading.Event()

    def stop(self):
        self.stopped.set()

    def publish(self, frame):
        h, w = frame.shape[:2]
        scale = 320 / max(h, w)  # the real cane sends QVGA
        frame = cv2.resize(frame, (round(w * scale), round(h * scale)))
        ok, data = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if ok:
            with self.lock:
                self.jpeg = data.tobytes()

    def run(self):
        path = Path(self.source)
        if path.is_dir():
            images = sorted(p for p in path.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))
            if not images:
                raise SystemExit(f"No pictures in {path}")
            while not self.stopped.is_set():
                for image in images:
                    frame = cv2.imread(str(image))
                    if frame is not None:
                        self.publish(frame)
                    if self.stopped.wait(self.seconds_per_image):
                        return
            return
        capture = cv2.VideoCapture(int(self.source) if self.source.isdigit() else self.source)
        if not capture.isOpened():
            raise SystemExit(f"Could not open {self.source} (check Camera permission for a webcam)")
        while not self.stopped.is_set():
            ok, frame = capture.read()
            if not ok:  # video file ended: start over
                capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            else:
                self.publish(frame)
            self.stopped.wait(1 / self.fps)
        capture.release()

    def latest(self):
        with self.lock:
            return self.jpeg


class Cane:
    def __init__(self, cm, on, say):
        self.lock = threading.Lock()
        self.cm, self.on, self.say = cm, on, say
        self.spoken = []
        self.warn_requests = 0
        # Like voice.cpp: finish the current sentence, keep only the newest waiting one.
        self.next_sentence = None
        self.wake = threading.Event()
        if say:
            threading.Thread(target=self.speaker, daemon=True).start()

    def speaker(self):
        while True:
            self.wake.wait()
            with self.lock:
                sentence, self.next_sentence = self.next_sentence, None
                self.wake.clear()
            if sentence:
                subprocess.run(["say", "-r", "170", sentence])

    def state(self):
        with self.lock:
            return {"on": self.on, "cm": self.cm, "beeper": beeper(self.cm, self.on), "spoken": list(self.spoken),
                    "warn_requests": self.warn_requests}

    def warn(self, msg):
        """Returns (HTTP status, reply), exactly like warn_handler()."""
        with self.lock:
            self.warn_requests += 1
            if not self.on:
                return 200, "ignored: cane is off\n"
            alert = parse_warning(msg)
            if alert is None:
                return 400, "nothing to say\n"
            self.spoken.append({"at": time.time(), "msg": msg, "sentence": alert.sentence})
        print(f"CANE SAYS: {alert.sentence}", flush=True)
        if self.say:
            with self.lock:
                self.next_sentence = alert.sentence
            self.wake.set()
        return 200, "ok\n"


def control_handler(cane):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, code, body, kind="text/plain"):
            data = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            url = urlparse(self.path)
            query = parse_qs(url.query)
            if url.path == "/distance":
                state = cane.state()
                cm = state["cm"] if state["on"] else None
                self.reply(200, json.dumps({"on": state["on"], "cm": None if cm is None else round(cm, 1)}), "application/json")
            elif url.path == "/warn":
                if "msg" not in query:
                    self.reply(400, "usage: /warn?msg=chair,0.9\n")
                else:
                    self.reply(*cane.warn(query["msg"][0]))
            elif url.path == "/sim":
                with cane.lock:
                    if "cm" in query:
                        value = query["cm"][0]
                        cane.cm = None if value in ("none", "") else max(2.0, min(400.0, float(value)))
                    if "on" in query:
                        cane.on = query["on"][0] == "1"
                self.reply(200, json.dumps(cane.state()), "application/json")
            else:
                self.reply(404, "not found\n")

        def log_message(self, *args):
            pass

    return Handler


def stream_handler(frames):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if urlparse(self.path).path != "/stream":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace;boundary=frame")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                while not frames.stopped.is_set():  # stopping the cane cuts the stream, like losing WiFi
                    jpeg = frames.latest()
                    if jpeg:
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                         + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
                    time.sleep(1 / frames.fps)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *args):
            pass

    return Handler


def start(source="0", port=8080, cm=100.0, on=True, say=False, seconds_per_image=4.0, bind="127.0.0.1"):
    frames = Frames(source, seconds_per_image=seconds_per_image)
    frames.start()
    cane = Cane(cm, on, say)
    servers = [ThreadingHTTPServer((bind, port), control_handler(cane)),
               ThreadingHTTPServer((bind, port + 1), stream_handler(frames))]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()

    def stop():
        frames.stop()
        for server in servers:
            server.shutdown()
            server.server_close()
    return cane, stop


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="0", help="webcam number, video file, or folder of pictures (default: webcam 0)")
    ap.add_argument("--port", type=int, default=8080, help="control port; video is on the next port (default 8080)")
    ap.add_argument("--cm", default="100", help="starting sonar distance in cm, or 'none'")
    ap.add_argument("--off", action="store_true", help="start switched off, like the real cane")
    ap.add_argument("--say", action="store_true", help="speak warnings out loud on the laptop")
    ap.add_argument("--seconds-per-image", type=float, default=4.0)
    args = ap.parse_args()
    cm = None if args.cm == "none" else float(args.cm)
    start(args.source, args.port, cm, not args.off, args.say, args.seconds_per_image)
    print(f"Simulated cane ready. In the app, use cane address 127.0.0.1:{args.port}", flush=True)
    print(f"Move the obstacle: http://127.0.0.1:{args.port}/sim?cm=60   Switch off: /sim?on=0", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
