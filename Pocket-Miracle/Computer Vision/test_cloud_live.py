"""Opt-in live integration test. Uses temporary test accounts supplied via env.

PM_TEST_USERS_JSON must contain [{id,email,password}, ...]. This script never
opens hardware and never prints access tokens. Test accounts are cleaned up by
the caller after browser checks.
"""
import json
import os
import tempfile
import time
import urllib.request
from pathlib import Path
from unittest.mock import patch

from cloud import Cloud, CloudError, HistorySync
from serve import VisionService
from test_serve import FakeModel, FakeSource


def login(cloud, user):
    request = urllib.request.Request(cloud.url + "/auth/v1/token?grant_type=password", method="POST",
                                     headers={"apikey": cloud.key, "Content-Type": "application/json"},
                                     data=json.dumps({"email": user["email"], "password": user["password"]}).encode())
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)["access_token"]


def main():
    users = json.loads(os.environ["PM_TEST_USERS_JSON"])
    cloud = Cloud()
    tokens = [login(cloud, user) for user in users]
    for user, token in zip(users, tokens):
        assert cloud.verify(token) == user["id"]
    with tempfile.TemporaryDirectory() as directory:
        history = HistorySync(cloud, Path(directory) / "test.sqlite3", autostart=False)
        service = VisionService("fixture-model.pt", cloud, history)
        try:
            with patch("serve.load_model", return_value=FakeModel()), patch("serve.make_source", side_effect=lambda *args: (FakeSource(), "fixture")):
                for user, token in zip(users, tokens):
                    service.authenticate("Bearer " + token)
                    service.start({"mode": "webcam", "simulated_cm": 80}, user["id"], token)
                    deadline = time.time() + 5
                    while (not service.status(user["id"]).get("last_warning") or not service.session.events) and time.time() < deadline:
                        time.sleep(.03)
                    assert service.status(user["id"]).get("last_warning"), service.status(user["id"])
                    service.stop(user["id"])
                    service.session.thread.join(6)
                    assert not service.session.thread.is_alive()
                    deadline = time.time() + 40
                    while history.status(user["id"])["pending"] and time.time() < deadline:
                        if not history.flush_once():
                            time.sleep(.3)
                    assert history.status(user["id"])["pending"] == 0, history.status(user["id"])
                    runs = cloud.request("/rest/v1/detection_sessions?select=*", token)
                    assert len(runs) == 1 and runs[0]["user_id"] == user["id"] and runs[0]["status"] == "stopped"
                    events = cloud.request("/rest/v1/detection_events?select=*", token)
                    warnings = cloud.request("/rest/v1/warnings?select=*", token)
                    assert len(events) == 1 and events[0]["object_label"] == "chair"
                    assert len(warnings) == 1 and warnings[0]["delivery_status"] == "local_only"
                    assert warnings[0]["is_simulated"]
            other_runs = cloud.request("/rest/v1/detection_sessions?select=id", tokens[0])
            foreign = cloud.request(f"/rest/v1/detection_sessions?id=eq.{other_runs[0]['id']}&select=*", tokens[1])
            assert foreign == [], "Another account could read history"
            try:
                cloud.request("/rest/v1/detection_events", tokens[1], "POST", {
                    "session_id": other_runs[0]["id"], "object_label": "spoof", "peak_confidence": .9, "position": "ahead"})
                raise AssertionError("Another account could insert into a foreign run")
            except (PermissionError, CloudError):
                pass
            print("Live Supabase: two real logins, per-user session/event/warning persistence, and cross-account RLS checks passed.")
        finally:
            service.stop()
            if service.session:
                service.session.thread.join(6)
            history.close()


if __name__ == "__main__":
    main()
