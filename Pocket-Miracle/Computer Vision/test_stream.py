"""
Smart Cane - camera stream + YOLO + sonar warning test.

Reads live video from the cane's ESP32 camera, runs a pre-trained YOLO model
on every frame, reads the cane's sonar distance, and decides when the cane
should warn (rules in cane_logic.py). Proves camera -> WiFi -> model -> warning.

Usage (laptop must be on the same iPhone hotspot as the cane):
    python test_stream.py 172.20.10.3            # cane video + sonar; the cane speaks warnings
    python test_stream.py 172.20.10.3 --say      # also speak warnings on the laptop
    python test_stream.py 172.20.10.3 --capture  # poll /capture instead (fallback)
    python test_stream.py 0 --sonar-cm 80        # laptop webcam + pretend sonar says 80 cm

Keys in the video window:
    q / Esc  quit
    s        save the current raw frame to data/raw/ (for building the dataset)
    p        pause / resume detection

Box colors:
    red    watched object (person, chair, ...) straight ahead -> can trigger a warning
    green  watched object off to the side
    gray   object we don't warn about (cup, phone, ...)
"""

import argparse
import json
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from cane_logic import Detection, WarningDecider

HERE = Path(__file__).resolve().parent
SAVE_DIR = HERE / "data" / "raw"

RED = (0, 0, 255)
GREEN = (0, 200, 0)
GRAY = (150, 150, 150)


# ---------------------------------------------------------------------------
#  Frame sources. Each runs in a background thread and keeps only the newest
#  frame, so a slow model never makes the video lag behind reality.
# ---------------------------------------------------------------------------
class FrameSource(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self._lock = threading.Lock()
        self._frame = None
        self._frame_id = 0
        self._stop_event = threading.Event()
        self.status = "connecting..."
        self.fps = 0.0
        self.last_frame_time = 0.0
        self._fps_count = 0
        self._fps_start = time.time()

    def _publish(self, frame):
        with self._lock:
            self._frame = frame
            self._frame_id += 1
        self.last_frame_time = time.time()
        self._fps_count += 1
        elapsed = time.time() - self._fps_start
        if elapsed >= 1.0:
            self.fps = self._fps_count / elapsed
            self._fps_count = 0
            self._fps_start = time.time()

    def latest(self):
        """Returns (frame, frame_id). frame is None until the first one arrives."""
        with self._lock:
            return self._frame, self._frame_id

    def stop(self):
        self._stop_event.set()


class MjpegStream(FrameSource):
    """Reads the ESP32 MJPEG stream by cutting JPEGs out of the raw bytes."""

    def __init__(self, url, timeout=5.0):
        super().__init__()
        self.url = url
        self.timeout = timeout

    def run(self):
        while not self._stop_event.is_set():
            try:
                with urllib.request.urlopen(self.url, timeout=self.timeout) as resp:
                    self.status = "connected"
                    buf = bytearray()
                    while not self._stop_event.is_set():
                        chunk = resp.read(4096)
                        if not chunk:
                            raise ConnectionError("stream ended")
                        buf += chunk
                        buf = self._extract_frames(buf)
            except Exception as e:  # network errors: report and retry
                self.status = f"reconnecting ({type(e).__name__}: {e})"
                time.sleep(1.0)

    def _extract_frames(self, buf):
        # A JPEG starts with FF D8 and ends with FF D9.
        while True:
            start = buf.find(b"\xff\xd8")
            if start == -1:
                return buf[-1:]  # keep one byte in case it's the first half of FF D8
            end = buf.find(b"\xff\xd9", start + 2)
            if end == -1:
                return buf[start:]  # frame not finished yet
            jpg = bytes(buf[start:end + 2])
            buf = buf[end + 2:]
            frame = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
            if frame is not None:
                self._publish(frame)


class CapturePoller(FrameSource):
    """Fallback: grabs single photos from http://<ip>/capture in a loop.
    Slower than the stream, but works even while another device holds the stream."""

    def __init__(self, url, timeout=5.0):
        super().__init__()
        self.url = url
        self.timeout = timeout

    def run(self):
        while not self._stop_event.is_set():
            try:
                with urllib.request.urlopen(self.url, timeout=self.timeout) as resp:
                    data = resp.read()
                frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    raise ValueError("response was not an image")
                self.status = "connected"
                self._publish(frame)
                time.sleep(0.05)  # don't hammer the ESP32 (max ~20 requests/s)
            except Exception as e:
                self.status = f"reconnecting ({type(e).__name__}: {e})"
                time.sleep(1.0)


class Webcam(FrameSource):
    """Laptop webcam, for testing the model without the cane."""

    def __init__(self, index):
        super().__init__()
        self.index = index

    def run(self):
        cap = cv2.VideoCapture(self.index)
        if not cap.isOpened():
            self.status = f"could not open webcam {self.index} (check Camera permission)"
            return
        self.status = "connected"
        while not self._stop_event.is_set():
            ok, frame = cap.read()
            if ok:
                self._publish(frame)
            else:
                time.sleep(0.05)
        cap.release()


def make_source(source, use_capture):
    if source.isdigit():
        return Webcam(int(source)), f"webcam {source}"
    if source.startswith("http"):
        url = source
    elif use_capture:
        url = f"http://{source}/capture"
    else:
        url = f"http://{source}:81/stream"
    cls = CapturePoller if use_capture or url.endswith("/capture") else MjpegStream
    return cls(url), url


# ---------------------------------------------------------------------------
#  Sonar. The cane serves its latest reading at http://<ip>/distance as
#  {"on": true, "cm": 85.3}. On the phone this will come over Bluetooth instead.
# ---------------------------------------------------------------------------
class SonarPoller(threading.Thread):
    def __init__(self, url, interval=0.2):
        super().__init__(daemon=True)
        self.url = url
        self.interval = interval
        self._lock = threading.Lock()
        self._reading = (None, None, None)  # (cm or None, cane on?, time of reading)
        self._stop_event = threading.Event()
        self.status = "connecting..."

    def run(self):
        while not self._stop_event.is_set():
            try:
                with urllib.request.urlopen(self.url, timeout=1.0) as resp:
                    data = json.loads(resp.read())
                cm = data.get("cm")
                with self._lock:
                    self._reading = (float(cm) if cm is not None else None,
                                     bool(data.get("on")), time.time())
                self.status = "ok"
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    self.status = "cane has no /distance yet (upload the new app_httpd.cpp)"
                else:
                    self.status = f"error HTTP {e.code}"
            except Exception as e:
                self.status = f"not connected ({type(e).__name__})"
            self._stop_event.wait(self.interval)

    def reading(self):
        with self._lock:
            return self._reading

    def describe(self, max_age):
        cm, on, t = self.reading()
        if t is None:
            return f"Sonar: {self.status}"
        if time.time() - t > max_age:
            return f"Sonar: no fresh reading ({self.status})"
        if not on:
            return "Sonar: cane is OFF (hold the switch 2 s)"
        if cm is None:
            return "Sonar: nothing in range"
        return f"Sonar: {cm:.0f} cm"

    def stop(self):
        self._stop_event.set()


class FixedSonar:
    """Pretend sonar for webcam testing (--sonar-cm)."""

    def __init__(self, cm):
        self.cm = cm

    def start(self):
        pass

    def stop(self):
        pass

    def reading(self):
        return self.cm, True, time.time()

    def describe(self, max_age):
        return f"Sonar: {self.cm:.0f} cm (pretend)"


def cane_host(source):
    """The cane's IP from the source argument, or None for a webcam."""
    if source.isdigit():
        return None
    return urllib.parse.urlparse(source).hostname if source.startswith("http") else source


def make_sonar(args):
    if args.sonar_cm is not None:
        return FixedSonar(args.sonar_cm)
    host = cane_host(args.source)
    if host is None:
        return None  # webcam with no pretend distance: no sonar at all
    return SonarPoller(f"http://{host}/distance")


# ---------------------------------------------------------------------------
#  Cane voice: sends each warning to http://<ip>/warn?msg=chair,0.9 and the
#  cane says it. Runs in the background so slow WiFi never freezes the video.
#  On the phone this will be the same request (or Bluetooth).
# ---------------------------------------------------------------------------
class CaneVoice(threading.Thread):
    def __init__(self, base_url, on_delivery=None):
        super().__init__(daemon=True)
        self.base_url = base_url
        self.on_delivery = on_delivery
        self._lock = threading.Lock()
        self._pending = None
        self._wake = threading.Event()
        self._stop_event = threading.Event()
        self._failed = []  # words whose warning didn't reach the cane
        self.status = ""

    def send(self, alert):
        with self._lock:
            previous = self._pending
            self._pending = alert  # a newer warning replaces one not sent yet
        if previous is not None:
            self._report(previous, "cancelled", "Replaced by a newer warning before transmission.")
        self._wake.set()

    def _report(self, alert, status, error=None):
        if self.on_delivery:
            try:
                self.on_delivery(alert, status, error)
            except Exception as failure:
                print(f"Could not record warning delivery: {type(failure).__name__}")

    def take_failed(self):
        """Words whose warning didn't get through (so they can be sent again)."""
        with self._lock:
            failed, self._failed = self._failed, []
        return failed

    def run(self):
        while not self._stop_event.is_set():
            self._wake.wait(0.5)
            self._wake.clear()
            if self._stop_event.is_set():
                break
            with self._lock:
                alert, self._pending = self._pending, None
            if alert is None:
                continue
            url = f"{self.base_url}/warn?msg={urllib.parse.quote(alert.message, safe=',.')}"
            delivered = False
            accepted = False
            self._report(alert, "sending")
            try:
                with urllib.request.urlopen(url, timeout=2.0) as resp:
                    reply = resp.read().decode(errors="replace").strip()
                self.status = f"Cane voice: {reply}"
                delivered = reply == "ok"  # e.g. "ignored: cane is off" = not said
                accepted = delivered
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    self.status = "Cane voice: cane has no /warn yet (upload the new sketch)"
                    delivered = True  # retrying won't help
                else:
                    self.status = f"Cane voice: error HTTP {e.code}"
            except Exception as e:
                self.status = f"Cane voice: not reachable ({type(e).__name__})"
            if not delivered:
                with self._lock:
                    self._failed.append(alert.word)
                self.status += " - will resend"
            self._report(alert, "acknowledged" if accepted else "failed", None if accepted else self.status)
            print(f"   {self.status}")

    def stop(self):
        self._stop_event.set()
        with self._lock:
            pending, self._pending = self._pending, None
        if pending is not None:
            self._report(pending, "cancelled", "Detection stopped before transmission.")
        self._wake.set()


# ---------------------------------------------------------------------------
#  Laptop speech (--say), so you can hear what the cane would say.
#  A new warning cuts off one that's still playing.
# ---------------------------------------------------------------------------
class Speaker:
    def __init__(self):
        self._proc = None

    def say(self, text):
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()
        try:
            self._proc = subprocess.Popen(["say", text])
        except FileNotFoundError:
            print("(--say only works on a Mac)")


# ---------------------------------------------------------------------------
#  Drawing helpers
# ---------------------------------------------------------------------------
FONT = cv2.FONT_HERSHEY_SIMPLEX


def draw_center_band(img, x0, x1):
    """Shades the middle strip of the image (where the sonar points)."""
    h = img.shape[0]
    overlay = img.copy()
    cv2.rectangle(overlay, (x0, 0), (x1, h), (255, 200, 0), -1)
    cv2.addWeighted(overlay, 0.15, img, 0.85, 0, dst=img)
    cv2.line(img, (x0, 0), (x0, h), (255, 200, 0), 1)
    cv2.line(img, (x1, 0), (x1, h), (255, 200, 0), 1)


def put_label(img, text, x, y, color, text_color=(255, 255, 255), size=0.5):
    """Text on a filled box so it's readable on any background. (x, y) = bottom-left."""
    (tw, th), base = cv2.getTextSize(text, FONT, size, 1)
    cv2.rectangle(img, (x, y - th - 4), (x + tw + 6, y + base), color, -1)
    cv2.putText(img, text, (x + 3, y - 2), FONT, size, text_color, 1, cv2.LINE_AA)


def put_lines(img, lines, color=(255, 255, 255)):
    y = 24
    for line in lines:
        if line:
            put_label(img, line, 6, y, (0, 0, 0), color, 0.55)
        y += 24


def draw_banner(img, text, color=RED, bottom=True):
    """Big bar along the bottom (warning sent) or top (problem) of the image."""
    h, w = img.shape[:2]
    y0 = h - 44 if bottom else 0
    cv2.rectangle(img, (0, y0), (w, y0 + 44), color, -1)
    cv2.putText(img, text[:70], (10, y0 + 30), FONT, 0.6, (255, 255, 255), 2, cv2.LINE_AA)


VIDEO_TIMEOUT_S = 2.0  # no new frame for this long = video lost


def waiting_screen(status, target):
    img = np.zeros((360, 720, 3), np.uint8)
    put_lines(img, [
        f"Waiting for video from {target}",
        f"Status: {status[:80]}",
        "",
        "Checklist:",
        "- Laptop on the SAME iPhone hotspot as the cane",
        "- Mac: Privacy & Security > Local Network > allow Terminal / VS Code",
        "- Close the stream in Safari (the cane serves only one stream viewer)",
        "- Or try:  --capture",
        "",
        "Press q to quit",
    ])
    return img


def pick_device(requested):
    if requested:
        return requested
    import torch
    return "mps" if torch.backends.mps.is_available() else "cpu"


# ---------------------------------------------------------------------------
#  Main loop
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Smart Cane camera + YOLO + sonar test")
    ap.add_argument("source", help="cane IP (e.g. 172.20.10.3), full URL, or webcam number (0)")
    ap.add_argument("--capture", action="store_true", help="poll /capture instead of the stream")
    ap.add_argument("--model", default="yolo11n.pt", help="YOLO weights (downloaded automatically)")
    ap.add_argument("--conf", type=float, default=0.35, help="minimum confidence to draw a box")
    ap.add_argument("--warn-conf", type=float, default=0.75, help="minimum confidence to warn (0-1)")
    ap.add_argument("--warn-cm", type=float, default=150, help="only warn when the sonar is closer than this")
    ap.add_argument("--forget", type=float, default=3.0,
                    help="seconds an object must be gone before it's announced again")
    ap.add_argument("--center", type=float, default=0.3, help="width of the straight-ahead band (0-1)")
    ap.add_argument("--sonar-cm", type=float, default=None, help="pretend sonar distance (for webcam tests)")
    ap.add_argument("--say", action="store_true", help="speak warnings out loud on the laptop")
    ap.add_argument("--no-cane-voice", action="store_true", help="don't send warnings to the cane")
    ap.add_argument("--imgsz", type=int, default=320, help="model input size (cane frames are 240x320, turned upright)")
    ap.add_argument("--device", default=None, help="mps, cpu, ... (default: mps if available)")
    ap.add_argument("--scale", type=float, default=2.0, help="window zoom (cane frames are tiny)")
    args = ap.parse_args()

    from ultralytics import YOLO  # imported here so --help is instant

    device = pick_device(args.device)
    print(f"Loading {args.model} on {device} ...")
    model = YOLO(args.model)

    source, target = make_source(args.source, args.capture)
    print(f"Reading video from {target}")
    source.start()

    sonar = make_sonar(args)
    if sonar is None:
        print("No sonar (webcam). Add --sonar-cm 80 to test warnings.")
    else:
        if isinstance(sonar, SonarPoller):
            print(f"Reading sonar from {sonar.url}")
        sonar.start()

    decider = WarningDecider(center_band=args.center, max_warn_cm=args.warn_cm,
                             min_conf=args.warn_conf, forget_s=args.forget)
    speaker = Speaker() if args.say else None
    cane_voice = None
    if cane_host(args.source) and not args.no_cane_voice:
        cane_voice = CaneVoice(f"http://{cane_host(args.source)}")
        cane_voice.start()
        print(f"Sending warnings to {cane_voice.base_url}/warn")

    SAVE_DIR.mkdir(parents=True, exist_ok=True)
    win = "Smart Cane vision test"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)

    last_id = -1
    paused = False
    shown = None       # what's in the window
    shown_raw = None   # the camera frame (no boxes) behind what's in the window
    infer_ms = 0.0
    banner_text, banner_until = "", 0.0

    try:
        while True:
            frame, frame_id = source.latest()
            video_lost = frame is not None and time.time() - source.last_frame_time > VIDEO_TIMEOUT_S

            if frame is None:
                shown = waiting_screen(source.status, target)
            elif frame_id != last_id and not paused:
                last_id = frame_id
                shown_raw = frame
                t0 = time.time()
                # agnostic_nms: one object gets one box (not both "car" and "truck")
                result = model.predict(frame, conf=args.conf, imgsz=args.imgsz,
                                       device=device, agnostic_nms=True, verbose=False)[0]
                infer_ms = (time.time() - t0) * 1000
                h, w = frame.shape[:2]

                detections = []
                for box in result.boxes:
                    x0, y0, x1, y1 = box.xyxy[0].tolist()
                    detections.append(Detection(model.names[int(box.cls)], float(box.conf),
                                                x0, y0, x1, y1))

                # Decide whether to warn (all the rules live in cane_logic.py)
                now = time.time()
                cm, on, t = sonar.reading() if sonar else (None, None, None)
                if cane_voice:
                    for word in cane_voice.take_failed():
                        decider.forget(word)  # didn't reach the cane: allow it again
                alert = decider.update(detections, w, cm, t, now, cane_on=(on is not False))
                if alert:
                    print(f"SEND -> {alert.message}    (cane says: \"{alert.sentence}\")")
                    banner_text, banner_until = f"SEND {alert.message}: {alert.sentence}", now + 3.0
                    if speaker:
                        speaker.say(alert.sentence)
                    if cane_voice:
                        cane_voice.send(alert)

                # Zoom first, then draw, so labels stay readable on tiny frames.
                s = args.scale
                shown = cv2.resize(frame, None, fx=s, fy=s, interpolation=cv2.INTER_LINEAR)
                bx0, bx1 = decider.band(w)
                draw_center_band(shown, int(bx0 * s), int(bx1 * s))

                for d in detections:
                    watched = decider.is_watched(d)
                    ahead = decider.is_ahead(d, w)
                    color = RED if (watched and ahead) else GREEN if watched else GRAY
                    p0 = (int(d.x0 * s), int(d.y0 * s))
                    p1 = (int(d.x1 * s), int(d.y1 * s))
                    cv2.rectangle(shown, p0, p1, color, 2 if color == RED else 1)
                    put_label(shown, f"{d.name} {d.conf:.2f}", p0[0], max(p0[1], 18), color)

                put_lines(shown, [
                    f"{w}x{h}  stream {source.fps:.1f} fps  model {infer_ms:.0f} ms",
                    sonar.describe(decider.sonar_max_age_s) if sonar else "Sonar: none (use --sonar-cm)",
                    decider.status,
                    cane_voice.status if cane_voice else "",
                ], color=(0, 255, 0))
                if now < banner_until:
                    draw_banner(shown, banner_text)

            if shown is not None:
                display = shown
                if video_lost:
                    # Old picture + loud notice. No new frames = no warnings.
                    display = shown.copy()
                    why = "stream stalled" if source.status == "connected" else source.status
                    draw_banner(display, f"NO VIDEO - {why}", (0, 0, 180), bottom=False)
                elif paused and shown_raw is not None:
                    display = shown.copy()
                    draw_banner(display, "PAUSED - no warnings (press p)", (90, 90, 90), bottom=False)
                cv2.imshow(win, display)

            key = cv2.waitKey(10) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord("p"):
                paused = not paused
                print("Paused" if paused else "Resumed")
            if key == ord("s"):
                if shown_raw is None or video_lost:
                    print("Not saved: no live video")
                else:
                    # Save the frame that's on screen (raw, no boxes)
                    name = datetime.now().strftime("cane_%Y%m%d_%H%M%S_%f")[:-3] + ".jpg"
                    cv2.imwrite(str(SAVE_DIR / name), shown_raw)
                    print(f"Saved data/raw/{name}")
    except KeyboardInterrupt:
        pass
    finally:
        source.stop()
        if sonar:
            sonar.stop()
        if cane_voice:
            cane_voice.stop()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
