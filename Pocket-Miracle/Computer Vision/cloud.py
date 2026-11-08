"""User-scoped Supabase access and a durable history outbox. No service key."""
import base64
import hashlib
import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def iso_time(timestamp=None):
    return datetime.fromtimestamp(time.time() if timestamp is None else timestamp, timezone.utc).isoformat()


class CloudError(Exception):
    pass


class Cloud:
    def __init__(self):
        config_path = Path(__file__).resolve().parent.parent / "App/frontend/src/supabase-config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        self.url = os.environ.get("SUPABASE_URL", config["url"]).rstrip("/")
        self.key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", config["publishableKey"])
        self.cache = {}
        self.lock = threading.Lock()

    def request(self, path, token, method="GET", payload=None):
        headers = {"apikey": self.key, "Authorization": f"Bearer {token}",
                   "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"}
        request = urllib.request.Request(self.url + path, headers=headers, method=method,
                                         data=None if payload is None else json.dumps(payload).encode())
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                body = response.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as error:
            body = error.read().decode(errors="replace")
            if error.code in (401, 403):
                raise PermissionError("Your session has expired or does not have access. Log in again.") from None
            try:
                detail = json.loads(body).get("message") or json.loads(body).get("msg") or "Request failed."
            except ValueError:
                detail = "Request failed."
            raise CloudError(f"Supabase {error.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise CloudError("Cannot reach Supabase. Check the laptop's internet connection.") from None

    def verify(self, token):
        if not token:
            raise PermissionError("Log in to use the vision service.")
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.lock:
            cached = self.cache.get(digest)
            if cached and cached[0] > time.time():
                return cached[1]
        user = self.request("/auth/v1/user", token)
        if not user or not user.get("id") or user.get("is_anonymous"):
            raise PermissionError("A signed-in account is required.")
        # JWT decoding here only bounds cache lifetime; Supabase verified identity.
        try:
            payload = token.split(".")[1]
            expires = float(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["exp"])
        except (ValueError, KeyError, IndexError, TypeError):
            raise PermissionError("Invalid access token.") from None
        if expires <= time.time():
            raise PermissionError("Your session has expired. Log in again.")
        with self.lock:
            self.cache = {key: value for key, value in self.cache.items() if value[0] > time.time()}
            if len(self.cache) >= 128:
                self.cache.clear()
            self.cache[digest] = (min(time.time() + 30, expires), user["id"])
        return user["id"]

    def settings(self, token):
        rows = self.request("/rest/v1/app_settings?select=voice_enabled,warning_distance_cm,warning_confidence", token)
        if not rows:
            raise CloudError("Account settings are missing. Reload the app first.")
        return rows[0]


class HistorySync:
    """FIFO per account; failed uploads remain on disk until that user reconnects."""
    def __init__(self, cloud, path, autostart=True):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("create table if not exists outbox(id integer primary key autoincrement,user_id text not null,method text not null,path text not null,payload text not null)")
        self.db.execute("create index if not exists outbox_user_idx on outbox(user_id,id)")
        self.db.commit()
        self.cloud = cloud
        self.lock = threading.Lock()
        self.tokens = {}
        self.errors = {}
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        if autostart:
            self.thread.start()

    def register(self, user, token):
        with self.lock:
            self.tokens[user] = token
        self.wake.set()

    def disconnect(self, user):
        with self.lock:
            self.tokens.pop(user, None)

    def push(self, user, table, payload, patch_id=None):
        path = f"/rest/v1/{table}" + (f"?id=eq.{patch_id}" if patch_id else "?on_conflict=id")
        with self.lock:
            self.db.execute("insert into outbox(user_id,method,path,payload) values(?,?,?,?)",
                            (user, "PATCH" if patch_id else "POST", path, json.dumps(payload)))
            self.db.commit()
        self.wake.set()

    def status(self, user):
        with self.lock:
            count = self.db.execute("select count(*) from outbox where user_id=?", (user,)).fetchone()[0]
            return {"pending": count, "error": self.errors.get(user, "")}

    def flush_once(self):
        with self.lock:
            users = list(self.tokens)
            if not users:
                return False
            row = self.db.execute(f"select id,user_id,method,path,payload from outbox where user_id in ({','.join('?' for _ in users)}) order by id limit 1", users).fetchone()
            if not row:
                return False
            key, user, method, path, payload = row
            token = self.tokens[user]
        try:
            self.cloud.request(path, token, method, json.loads(payload))
        except (CloudError, PermissionError) as error:
            with self.lock:
                self.errors[user] = str(error)
                if isinstance(error, PermissionError):
                    self.tokens.pop(user, None)
            return False
        with self.lock:
            self.db.execute("delete from outbox where id=?", (key,))
            self.db.commit()
            self.errors.pop(user, None)
        return True

    def run(self):
        while not self.stop_event.is_set():
            if not self.flush_once():
                self.wake.wait(2)
                self.wake.clear()

    def close(self):
        self.stop_event.set(); self.wake.set()
        if self.thread.is_alive():
            self.thread.join(6)
        if not self.thread.is_alive():
            self.db.close()
