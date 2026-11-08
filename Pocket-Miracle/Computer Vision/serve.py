"""Local laptop vision API. Run `python serve.py`, then start from the app."""
import argparse
import ipaddress
import json
import math
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import cv2

from cane_logic import Detection, WarningDecider
from test_stream import CaneVoice, FixedSonar, SonarPoller, make_source
from cloud import Cloud, CloudError, HistorySync, iso_time

HERE = Path(__file__).resolve().parent
FRAME_TIMEOUT = 3.0
HISTORY_MIN_CONFIDENCE = .70
HISTORY_CONFIRM_FRAMES = 3
HISTORY_WINDOW_FRAMES = 5


def load_model(path):
    from ultralytics import YOLO
    return YOLO(path)


def validate_config(data):
    mode = data.get("mode", "cane")
    if mode not in ("cane", "webcam"):
        raise ValueError("Choose cane or webcam.")
    host = str(data.get("host", "172.20.10.3"))
    if mode == "cane":
        try:
            address = ipaddress.IPv4Address(host)
        except ipaddress.AddressValueError:
            raise ValueError("Enter the cane's local IPv4 address.") from None
        if not (address.is_private and not address.is_unspecified and not address.is_multicast):
            raise ValueError("The cane address must be on a local network.")
    distance = data.get("simulated_cm")
    if distance is not None:
        if mode != "webcam":
            raise ValueError("Simulated distance is only available for webcam testing.")
        if isinstance(distance, bool) or not isinstance(distance, (float, int)) or not math.isfinite(distance) or not 1 <= distance <= 500:
            raise ValueError("Simulated distance must be between 1 and 500 cm.")
    return {"mode": mode, "host": host, "simulated_cm": distance,
            "send_warnings": mode == "cane" and data.get("send_warnings", True) is True}


class Session:
    def __init__(self, config, model_path, owner_id, history=None):
        self.config = {**config, "history_min_confidence": HISTORY_MIN_CONFIDENCE,
                       "history_confirm_frames": HISTORY_CONFIRM_FRAMES,
                       "history_window_frames": HISTORY_WINDOW_FRAMES, "history_watch_only": True}
        self.model_path = model_path
        self.id = str(uuid.uuid4())
        self.owner_id = owner_id
        self.history = history
        self.events = {}
        # Candidates never enter the persistence queue, including on shutdown.
        self.history_candidates = {}
        self.warning_ids = {}
        self.last_heartbeat = 0
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.source = self.sonar = self.voice = None
        self.jpeg = None
        self.state = {"session_id": self.id, "phase": "loading", "detail": "Loading detection model…",
                      "mode": config["mode"], "host": config["host"], "send_warnings": config["send_warnings"],
                      "simulated": config["simulated_cm"] is not None,
                      "frame_id": 0, "detections": [], "sonar_cm": None, "cane_on": None,
                      "sonar_fresh": False, "last_warning": None, "voice_status": "Not enabled",
                      "inference_ms": None}
        self.thread = threading.Thread(target=self.run, daemon=True)
        if self.history:
            self.history.push(self.owner_id, "detection_sessions", {
                "id": self.id, "user_id": self.owner_id, "source_type": config["mode"],
                "started_at": iso_time(), "last_heartbeat_at": iso_time(), "status": "starting",
                "model_name": Path(model_path).name, "config": self.config,
                "simulated_distance_cm": config["simulated_cm"],
            })

    def decider(self):
        return WarningDecider(max_warn_cm=self.config.get("warning_distance_cm", 150),
                              min_conf=self.config.get("warning_confidence", .75))

    def record_frame(self, detections, width, cm, fresh, now, alert, decider):
        if not self.history:
            return
        observations = {}
        for det in detections:
            if det.name not in decider.watch or not math.isfinite(det.conf) or det.conf < HISTORY_MIN_CONFIDENCE:
                continue
            key = det.name
            # Multiple boxes in one frame are not multiple confirmations.
            if key not in observations or det.conf > observations[key].conf:
                observations[key] = det
        candidates = {}
        # Class-level evidence tolerates camera motion; this is not object tracking.
        # Every processed frame advances the window, even if it contains no boxes.
        for name in self.history_candidates.keys() | observations.keys():
            det = observations.get(name)
            window = self.history_candidates.get(name, [])
            window = [hit if hit is not None and 0 <= now - hit[0] <= FRAME_TIMEOUT else None
                      for hit in window]
            window = (window + [(now, det.conf) if det is not None else None])[-HISTORY_WINDOW_FRAMES:]
            hits = [hit for hit in window if hit is not None]
            if hits:
                candidates[name] = window
            if det is None or len(hits) < HISTORY_CONFIRM_FRAMES:
                continue
            position = "ahead" if decider.is_ahead(det, width) else "left" if det.cx < width / 2 else "right"
            key = (name, position)
            event = self.events.get(key)
            if not event or now - event["seen"] > 3:
                if event:
                    self.history.push(self.owner_id, "detection_events", {"id": event["id"], **event["row"]})
                event = {"id": str(uuid.uuid4()), "seen": now, "flushed": 0, "row": {
                    "session_id": self.id, "object_label": det.name, "first_seen_at": iso_time(hits[0][0]),
                    "peak_confidence": 0, "position": position, "nearest_sonar_cm": None,
                    "distance_source": "unavailable", "warning_eligible": False,
                }}
                self.events[key] = event
            row = event["row"]
            row["last_seen_at"] = iso_time(now)
            row["peak_confidence"] = max(row["peak_confidence"], max(hit[1] for hit in hits))
            event["seen"] = now
            if fresh and cm is not None:
                row["nearest_sonar_cm"] = min(cm, row["nearest_sonar_cm"]) if row["nearest_sonar_cm"] is not None else cm
                row["distance_source"] = "simulated" if self.config["simulated_cm"] is not None else "sonar"
            qualifies = bool(alert and position == "ahead" and decider.watch.get(det.name) == alert.word)
            row["warning_eligible"] = row["warning_eligible"] or qualifies
            row["decision_reason"] = decider.status if position == "ahead" else "outside_center_band"
            if now - event["flushed"] >= 2 or qualifies:
                self.history.push(self.owner_id, "detection_events", {"id": event["id"], **row})
                event["flushed"] = now
        # Only confirmed, currently observed classes update saved history.
        self.history_candidates = candidates
        if alert:
            candidates = [event for (name, position), event in self.events.items()
                          if position == "ahead" and decider.watch.get(name) == alert.word and now - event["seen"] <= 3]
            event_id = max(candidates, key=lambda e: e["seen"])["id"] if candidates else None
            warning_id = str(uuid.uuid4())
            if self.voice:
                self.warning_ids[id(alert)] = warning_id
            self.history.push(self.owner_id, "warnings", {
                "id": warning_id, "session_id": self.id, "detection_event_id": event_id,
                "created_at": iso_time(now), "object_label": alert.word, "message": alert.sentence,
                "payload": alert.message, "distance_cm": cm if alert.meters is not None else None,
                "is_simulated": self.config["simulated_cm"] is not None,
                "delivery_status": "queued" if self.voice else "local_only",
            })

    def record_delivery(self, alert, status, error=None):
        warning_id = self.warning_ids.get(id(alert))
        if not warning_id or not self.history:
            return
        patch = {"delivery_status": "queued" if status == "sending" else status}
        if status != "cancelled":
            patch.update(attempt_count=1, last_attempt_at=iso_time())
        if status == "acknowledged":
            patch["acknowledged_at"] = iso_time()
        if error:
            patch["delivery_error"] = error
        self.history.push(self.owner_id, "warnings", patch, patch_id=warning_id)
        if status != "sending":
            self.warning_ids.pop(id(alert), None)

    def update(self, **values):
        with self.lock:
            self.state.update(values)

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    def stop(self):
        self.stop_event.set()
        for component in (self.source, self.sonar, self.voice):
            if component:
                component.stop()
        with self.lock:
            self.jpeg = None
            self.state.update(phase="stopped", detections=[], detail="Detection stopped.")

    def run(self):
        try:
            model = load_model(self.model_path)
            if self.stop_event.is_set():
                return
            cfg = self.config
            self.source, _ = make_source("0" if cfg["mode"] == "webcam" else cfg["host"], False)
            self.sonar = (FixedSonar(cfg["simulated_cm"]) if cfg["simulated_cm"] is not None else
                          SonarPoller(f"http://{cfg['host']}/distance") if cfg["mode"] == "cane" else None)
            self.voice = CaneVoice(f"http://{cfg['host']}", on_delivery=self.record_delivery) if cfg["send_warnings"] else None
            for component in (self.source, self.sonar, self.voice):
                if component:
                    component.start()
            decider = self.decider()
            last_id = -1
            self.update(phase="waiting", detail="Waiting for camera frames…")
            while not self.stop_event.is_set():
                frame, frame_id = self.source.latest()
                now = time.time()
                if self.history and now - self.last_heartbeat >= 5:
                    self.history.push(self.owner_id, "detection_sessions", {"last_heartbeat_at": iso_time(now)}, patch_id=self.id)
                    self.last_heartbeat = now
                if frame is None or now - self.source.last_frame_time > FRAME_TIMEOUT:
                    with self.lock:
                        self.jpeg = None
                    self.update(phase="waiting", detail=self.source.status, detections=[], sonar_fresh=False)
                    # Do not reuse temporal confirmations after video loss.
                    decider = self.decider()
                    self.history_candidates.clear()
                    self.stop_event.wait(.1)
                    continue
                if frame_id == last_id:
                    self.stop_event.wait(.02)
                    continue
                last_id = frame_id
                captured_at = self.source.last_frame_time
                started = time.perf_counter()
                result = model.predict(frame, conf=min(.35, self.config.get("warning_confidence", .75)), imgsz=320, agnostic_nms=True, verbose=False)[0]
                elapsed = (time.perf_counter() - started) * 1000
                if self.stop_event.is_set():
                    break
                # An inference that took too long must not warn on old video.
                now = time.time()
                if now - captured_at > FRAME_TIMEOUT:
                    self.history_candidates.clear()
                    continue
                detections = []
                for box in result.boxes:
                    coords = box.xyxy[0].tolist()
                    detections.append(Detection(model.names[int(box.cls[0])], float(box.conf[0]), *coords))
                cm, on, timestamp = self.sonar.reading() if self.sonar else (None, None, None)
                if self.voice:
                    for word in self.voice.take_failed():
                        decider.forget(word)
                height, width = frame.shape[:2]
                alert = decider.update(detections, width, cm, timestamp, now, cane_on=(on is not False))
                fresh = timestamp is not None and now - timestamp <= 1
                self.record_frame(detections, width, cm, fresh, now, alert, decider)
                if alert:
                    self.update(last_warning={"message": alert.sentence, "at": now,
                                              "simulated": cfg["simulated_cm"] is not None})
                    if self.voice and not self.stop_event.is_set():
                        self.voice.send(alert)
                annotated = frame.copy()
                for det in detections:
                    color = (0, 0, 230) if decider.is_watched(det) and decider.is_ahead(det, width) else (0, 180, 0)
                    cv2.rectangle(annotated, (int(det.x0), int(det.y0)), (int(det.x1), int(det.y1)), color, 2)
                    cv2.putText(annotated, f"{det.name} {det.conf:.0%}", (max(0, int(det.x0)), max(15, int(det.y0) - 5)), cv2.FONT_HERSHEY_SIMPLEX, .45, color, 1)
                ok, encoded = cv2.imencode(".jpg", annotated)
                if not ok:
                    continue
                with self.lock:
                    became_live = self.state["phase"] != "live"
                    self.jpeg = encoded.tobytes()
                    self.state.update(phase="live", detail=decider.status or "Watching for objects ahead.",
                                      frame_id=frame_id, inference_ms=round(elapsed, 1),
                                      sonar_cm=cm, cane_on=on,
                                      sonar_fresh=timestamp is not None and now - timestamp <= 1,
                                      voice_status=self.voice.status if self.voice else "Not enabled",
                                      detections=[{"name": d.name, "confidence": d.conf,
                                                   "ahead": decider.is_ahead(d, width),
                                                   "eligible": decider.is_watched(d)} for d in detections])
                if self.history and became_live:
                    self.history.push(self.owner_id, "detection_sessions", {"status": "running"}, patch_id=self.id)
        except Exception as error:
            if not self.stop_event.is_set():
                self.update(phase="error", detail=f"{type(error).__name__}: {error}", detections=[])
        finally:
            for component in (self.source, self.sonar, self.voice):
                if component:
                    component.stop()
                    if isinstance(component, threading.Thread) and component.is_alive():
                        component.join(timeout=5)
            if self.history:
                for event in self.events.values():
                    self.history.push(self.owner_id, "detection_events", {"id": event["id"], **event["row"]})
                failed = self.state["phase"] == "error"
                self.history.push(self.owner_id, "detection_sessions", {
                    "status": "failed" if failed else "stopped", "ended_at": iso_time(),
                    "last_heartbeat_at": iso_time(), "error_message": self.state["detail"] if failed else None,
                }, patch_id=self.id)


class VisionService:
    def __init__(self, model_path, cloud, history=None):
        self.model_path = model_path
        self.session = None
        self.lock = threading.Lock()
        self.cloud = cloud
        self.history = history

    def authenticate(self, authorization):
        token = authorization[7:] if authorization.startswith("Bearer ") else ""
        user = self.cloud.verify(token)
        if self.history:
            self.history.register(user, token)
        return user, token

    def start(self, data, user, token):
        config = validate_config(data)
        settings = self.cloud.settings(token)
        config.update(warning_distance_cm=settings["warning_distance_cm"], warning_confidence=float(settings["warning_confidence"]))
        config["send_warnings"] = config["send_warnings"] and settings["voice_enabled"]
        with self.lock:
            if self.session:
                if self.session.owner_id != user and self.session.thread.is_alive():
                    raise ValueError("The shared camera is in use by another account. Wait for that run to finish.")
                self.session.stop()
                self.session.thread.join(timeout=6)
                if self.session.thread.is_alive():
                    raise ValueError("Previous session is still stopping. Try again shortly.")
            self.session = Session(config, self.model_path, user, self.history)
            self.session.thread.start()
        return self.status(user)

    def stop(self, user=None):
        with self.lock:
            if self.session and (user is None or self.session.owner_id == user):
                self.session.stop()
        return self.status(user)

    def status(self, user=None):
        result = self.session.snapshot() if self.session and (user is None or self.session.owner_id == user) else {
            "phase": "idle", "detail": "Choose the cane or webcam to start detection.",
            "session_id": None, "frame_id": 0, "detections": [], "last_warning": None}
        if self.session and self.session.owner_id != user and self.session.thread.is_alive():
            result.update(shared_busy=True, detail="The shared camera is currently in use. Try again when that run ends.")
        if self.history and user:
            result["history_sync"] = self.history.status(user)
        return result


def allowed_origin(origin):
    parsed = urlparse(origin)
    return parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        def handle(self):
            try:
                super().handle()
            except ConnectionError:
                # Browsers cancel polling/image requests when switching tabs.
                pass

        def end_headers(self):
            origin = self.headers.get("Origin", "")
            if allowed_origin(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def respond(self, data, code=200):
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            if not allowed_origin(self.headers.get("Origin", "")):
                self.respond({"error": "Local app origins only."}, 403)
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.end_headers()

        def do_GET(self):
            try:
                user, _ = service.authenticate(self.headers.get("Authorization", ""))
            except PermissionError as error:
                self.respond({"error": str(error)}, 401); return
            except CloudError as error:
                self.respond({"error": str(error)}, 503); return
            path = urlparse(self.path).path
            if path == "/api/status":
                self.respond(service.status(user))
            elif path == "/api/frame.jpg":
                session = service.session
                if session and session.owner_id == user:
                    with session.lock:
                        jpeg = session.jpeg if session.state["phase"] == "live" else None
                else:
                    jpeg = None
                if jpeg:
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(jpeg)))
                    self.end_headers()
                    self.wfile.write(jpeg)
                else:
                    self.respond({"error": "No current camera frame."}, 404)
            else:
                self.respond({"error": "Not found."}, 404)

        def do_POST(self):
            origin = self.headers.get("Origin")
            if origin and not allowed_origin(origin):
                self.respond({"error": "Local app origins only."}, 403)
                return
            if self.headers.get_content_type() != "application/json":
                self.respond({"error": "Expected JSON."}, 415)
                return
            try:
                user, token = service.authenticate(self.headers.get("Authorization", ""))
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096:
                    raise ValueError("Invalid request size.")
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("Expected an object.")
                if self.path == "/api/start":
                    self.respond(service.start(data, user, token))
                elif self.path == "/api/stop":
                    self.respond(service.stop(user))
                elif self.path == "/api/disconnect":
                    result = service.stop(user)
                    if service.history:
                        service.history.disconnect(user)
                    self.respond(result)
                else:
                    self.respond({"error": "Not found."}, 404)
            except (ValueError, TypeError) as error:
                self.respond({"error": str(error)}, 400)
            except PermissionError as error:
                self.respond({"error": str(error)}, 401)
            except CloudError as error:
                self.respond({"error": str(error)}, 503)

        def log_message(self, format, *args):
            # Polling should not flood the terminal.
            if args and str(args[1]) not in ("200", "204"):
                super().log_message(format, *args)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default=str(HERE / "yolo11n.pt"))
    args = parser.parse_args()
    cloud = Cloud()
    history = HistorySync(cloud, HERE / "data/history_queue.sqlite3")
    service = VisionService(args.model, cloud, history)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(service))
    print(f"Laptop vision service: http://127.0.0.1:{args.port}", flush=True)
    print("Open the app's Camera tab to start. No camera opens until you choose Start.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()
        if service.session:
            service.session.thread.join(6)
        history.close()
        server.server_close()


if __name__ == "__main__":
    main()
