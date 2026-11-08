import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from cloud import Cloud, CloudError, HistorySync


class OutboxTests(unittest.TestCase):
    def test_failed_upload_survives_restart_and_only_replays_for_its_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            cloud = Mock()
            cloud.request.side_effect = CloudError("offline")
            first = HistorySync(cloud, path, autostart=False)
            first.register("user-a", "token-a")
            first.push("user-a", "detection_sessions", {"id": "session-a", "user_id": "user-a"})
            first.push("user-a", "warnings", {"id": "warning-a", "session_id": "session-a"})
            self.assertFalse(first.flush_once())
            self.assertEqual(first.status("user-a")["pending"], 2)
            first.close()
            cloud.request.side_effect = None
            replay = HistorySync(cloud, path, autostart=False)
            try:
                self.assertFalse(replay.tokens, "Tokens must not be persisted")
                replay.register("user-b", "token-b")
                self.assertFalse(replay.flush_once())
                replay.register("user-a", "fresh-token-a")
                self.assertTrue(replay.flush_once())
                self.assertIn("detection_sessions", cloud.request.call_args.args[0])
                self.assertEqual(cloud.request.call_args.args[1], "fresh-token-a")
                self.assertTrue(replay.flush_once())
                self.assertIn("warnings", cloud.request.call_args.args[0])
                self.assertEqual(replay.status("user-a")["pending"], 0)
                replay.disconnect("user-a")
                self.assertNotIn("user-a", replay.tokens)
            finally:
                replay.close()

    def test_missing_auth_cannot_reach_supabase(self):
        cloud = Cloud()
        cloud.request = Mock()
        with self.assertRaises(PermissionError):
            cloud.verify("")
        cloud.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
