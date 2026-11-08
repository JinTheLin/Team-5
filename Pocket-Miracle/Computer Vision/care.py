"""Caretaker link, SOS alerts and live-view approval, kept on the laptop.

The user shares a one-time code; the caretaker (a second account) enters it.
The caretaker always gets SOS alerts. The camera is shared only during a live
view, which starts when the user approves a request or presses SOS, and ends
after LIVE_SECONDS or when either side ends it.
"""
import json
import math
import secrets
import threading
import time
import uuid
from pathlib import Path

CODE_SECONDS = 10 * 60
LIVE_SECONDS = 10 * 60
MAX_FAILED_CODES = 5
LOCKOUT_SECONDS = 5 * 60
KEEP_ALERTS = 20


class Care:
    def __init__(self, path=None, email=lambda user_id: None):
        self.path = Path(path) if path else None
        self.email = email
        self.lock = threading.Lock()
        self.links = {}      # caretaker id -> user id
        self.codes = {}      # code -> (user id, expires)
        self.failures = {}   # caretaker id -> (failed tries, locked until)
        self.alerts = {}     # user id -> newest-last list of alerts
        self.live = {}       # user id -> live view
        if self.path and self.path.exists():
            self.links = json.loads(self.path.read_text())

    def _save(self):
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.links))

    def _person(self, user_id):
        return {"id": user_id, "email": self.email(user_id)}

    def _live(self, user_id, now):
        view = self.live.get(user_id)
        if view and view["state"] == "active" and now >= view["expires_at"]:
            self.live.pop(user_id)
            return None
        return view

    def caretakers(self, user_id):
        return [c for c, u in self.links.items() if u == user_id]

    def create_code(self, user_id):
        now = time.time()
        with self.lock:
            self.codes = {c: v for c, v in self.codes.items() if v[0] != user_id and v[1] > now}
            code = f"{secrets.randbelow(10 ** 6):06d}"
            while code in self.codes:
                code = f"{secrets.randbelow(10 ** 6):06d}"
            self.codes[code] = (user_id, now + CODE_SECONDS)
        return {"code": code, "expires_at": now + CODE_SECONDS}

    def link(self, caretaker_id, code):
        now = time.time()
        with self.lock:
            tries, locked_until = self.failures.get(caretaker_id, (0, 0))
            if locked_until > now:
                raise ValueError("Too many wrong codes. Try again in a few minutes.")
            entry = self.codes.get(str(code).strip())
            if not entry or entry[1] <= now:
                tries += 1
                self.failures[caretaker_id] = (0, now + LOCKOUT_SECONDS) if tries >= MAX_FAILED_CODES else (tries, 0)
                raise ValueError("That code is wrong or has expired. Ask for a new one.")
            user_id = entry[0]
            if user_id == caretaker_id:
                raise ValueError("Use a second account for the caretaker.")
            del self.codes[str(code).strip()]
            self.failures.pop(caretaker_id, None)
            self.links[caretaker_id] = user_id
            self._save()
        return self._person(user_id)

    def unlink(self, actor_id, caretaker_id=None):
        with self.lock:
            if caretaker_id is None:          # caretaker leaves
                removed = [actor_id] if actor_id in self.links else []
            elif self.links.get(caretaker_id) == actor_id:  # user removes a caretaker
                removed = [caretaker_id]
            else:
                raise ValueError("That caretaker isn't linked to you.")
            for c in removed:
                user_id = self.links.pop(c)
                view = self.live.get(user_id)
                if view and view["by"] == c:
                    self.live.pop(user_id)
            self._save()

    def sos(self, user_id, location=None):
        if location is not None:
            location = clean_location(location)
        now = time.time()
        with self.lock:
            caretakers = self.caretakers(user_id)
            alert = {"id": str(uuid.uuid4()), "kind": "sos", "at": now, "location": location,
                     "delivered_to": len(caretakers)}
            self.alerts.setdefault(user_id, []).append(alert)
            del self.alerts[user_id][:-KEEP_ALERTS]
            if caretakers:  # an SOS starts the live view without asking
                self.live[user_id] = {"state": "active", "by": caretakers[0], "reason": "sos",
                                      "requested_at": now, "expires_at": now + LIVE_SECONDS}
        return alert

    def request_live(self, caretaker_id):
        now = time.time()
        with self.lock:
            user_id = self.links.get(caretaker_id)
            if not user_id:
                raise ValueError("Link to a user first.")
            view = self._live(user_id, now)
            if not view:
                self.live[user_id] = {"state": "requested", "by": caretaker_id, "reason": "request",
                                      "requested_at": now, "expires_at": None}

    def respond(self, user_id, approve):
        now = time.time()
        with self.lock:
            view = self._live(user_id, now)
            if not view or view["state"] != "requested":
                raise ValueError("There is no live view request to answer.")
            if approve:
                view.update(state="active", expires_at=now + LIVE_SECONDS)
            else:
                self.live.pop(user_id)

    def end_live(self, actor_id):
        with self.lock:
            user_id = actor_id if actor_id in self.live else self.links.get(actor_id)
            if user_id:
                self.live.pop(user_id, None)

    def can_watch(self, caretaker_id):
        """User whose camera this caretaker may see right now, or None."""
        with self.lock:
            user_id = self.links.get(caretaker_id)
            view = self._live(user_id, time.time()) if user_id else None
            return user_id if view and view["state"] == "active" else None

    def _public_live(self, view):
        if not view:
            return None
        return {"state": view["state"], "reason": view["reason"], "requested_at": view["requested_at"],
                "expires_at": view["expires_at"], "by": self._person(view["by"])}

    def user_view(self, user_id):
        now = time.time()
        with self.lock:
            code = next(({"code": c, "expires_at": e} for c, (u, e) in self.codes.items() if u == user_id and e > now), None)
            return {"code": code, "caretakers": [self._person(c) for c in self.caretakers(user_id)],
                    "live": self._public_live(self._live(user_id, now)),
                    "alerts": list(reversed(self.alerts.get(user_id, [])[-5:]))}

    def caretaker_view(self, caretaker_id, user_status):
        """user_status(user_id) -> the user's detection status (shared only during a live view)."""
        now = time.time()
        with self.lock:
            user_id = self.links.get(caretaker_id)
            if not user_id:
                return {"linked": None}
            view = self._live(user_id, now)
            alerts = list(reversed(self.alerts.get(user_id, [])))
        status = user_status(user_id)
        result = {"linked": self._person(user_id), "alerts": alerts, "live": self._public_live(view),
                  "detection_running": status.get("phase") == "live"}
        if view and view["state"] == "active":
            result["camera"] = {key: status.get(key) for key in
                                ("phase", "detail", "session_id", "frame_id", "detections", "last_warning", "sonar_cm", "sonar_fresh")}
        return result


def clean_location(location):
    if not isinstance(location, dict):
        raise ValueError("Location must be an object.")
    try:
        lat, lng = float(location["lat"]), float(location["lng"])
        accuracy = float(location.get("accuracy") or 0)
    except (KeyError, TypeError, ValueError):
        raise ValueError("Location needs lat and lng numbers.") from None
    if not (math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180 and 0 <= accuracy < 1e6):
        raise ValueError("Location is out of range.")
    return {"lat": round(lat, 6), "lng": round(lng, 6), "accuracy": round(accuracy)}
