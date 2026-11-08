"""Offline regression tests for future history filtering; no camera or cloud."""
import copy
import unittest

from cane_logic import Alert, Detection
from serve import Session


class Recorder:
    def __init__(self):
        self.rows = []

    def push(self, owner, table, row, **kwargs):
        self.rows.append((table, copy.deepcopy(row)))

    def events(self):
        return [row for table, row in self.rows if table == "detection_events"]


def box(name="chair", confidence=.8, x=50):
    return Detection(name, confidence, x - 10, 10, x + 10, 80)


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.history = Recorder()
        self.session = Session({"mode": "webcam", "host": "", "simulated_cm": None,
                                "send_warnings": False}, "test.pt", "test-user", self.history)
        self.decider = self.session.decider()

    def frame(self, detections, now, alert=None):
        self.session.record_frame(detections, 100, None, False, now, alert, self.decider)

    def test_low_confidence_and_unwatched_never_become_events(self):
        for i in range(10):
            self.frame([box(confidence=.699), box("remote", .99),
                        box("refrigerator", .99), box("bottle", .99)], 100 + i * .1)
        self.assertEqual(self.history.events(), [])
        self.assertEqual(self.session.events, {})  # Nothing to flush at shutdown.

    def test_three_frames_at_boundary_confirm_and_group(self):
        for i in range(2):
            self.frame([box(confidence=.7)], 100 + i * .1)
        self.assertEqual(self.history.events(), [])
        self.frame([box(confidence=.7)], 100.2)
        self.assertEqual(len(self.history.events()), 1)
        self.assertEqual(self.history.events()[0]["peak_confidence"], .7)
        self.frame([box(confidence=.95)], 100.3)
        self.assertEqual(len(self.session.events), 1)
        self.assertEqual(next(iter(self.session.events.values()))["row"]["peak_confidence"], .95)

    def test_duplicate_boxes_do_not_confirm(self):
        self.frame([box(), box(), box()], 100)
        self.assertEqual(self.history.events(), [])
        self.assertEqual(len(self.session.history_candidates["chair"]), 1)

    def test_brief_misses_and_low_confidence_are_tolerated(self):
        for interruption in ([], [box(confidence=.4)], [box("person")]):
            with self.subTest(interruption=interruption):
                self.setUp()
                self.frame([box()], 100)
                self.frame([box()], 100.1)
                self.frame(interruption, 100.2)
                self.frame([box()], 100.3)
                self.assertEqual(len(self.history.events()), 1)

    def test_walking_position_changes_do_not_reset_confirmation(self):
        for i, x in enumerate((10, 50, 90)):
            self.frame([box(x=x)], 100 + i * .1)
        self.assertEqual(len(self.history.events()), 1)
        self.assertEqual(self.history.events()[0]["position"], "right")

    def test_three_of_five_not_three_of_unbounded_frames(self):
        for i, detections in enumerate(([box()], [], [box()], [], [box()])):
            self.frame(detections, 100 + i * .1)
        self.assertEqual(len(self.history.events()), 1)
        self.setUp()
        for i, detections in enumerate(([box()], [], [], [box()], [], [box()])):
            self.frame(detections, 100 + i * .1)
        self.assertEqual(self.history.events(), [])

    def test_distinct_classes_do_not_confirm_each_other(self):
        for i, name in enumerate(("chair", "person", "dog")):
            self.frame([box(name)], 100 + i * .1)
        self.assertEqual(self.history.events(), [])

    def test_stream_reset_discards_previous_evidence(self):
        self.frame([box()], 100)
        self.frame([box()], 100.1)
        self.session.history_candidates.clear()
        self.frame([box()], 100.2)
        self.assertEqual(self.history.events(), [])

    def test_video_gap_requires_fresh_confirmation(self):
        self.frame([box()], 100)
        self.frame([box()], 100.1)
        self.frame([box()], 104)
        self.assertEqual(self.history.events(), [])
        self.frame([box()], 104.1)
        self.frame([box()], 104.2)
        first_id = self.history.events()[0]["id"]
        for now in (108, 108.1, 108.2):
            self.frame([box()], now)
        self.assertNotEqual(first_id, self.history.events()[-1]["id"])

    def test_warning_can_persist_before_history_confirmation(self):
        self.frame([box()], 100)
        self.frame([box()], 100.1, Alert("chair", .8))
        warnings = [row for table, row in self.history.rows if table == "warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertIsNone(warnings[0]["detection_event_id"])
        self.assertEqual(self.history.events(), [])
        self.frame([box()], 100.2)
        self.assertEqual(len(self.history.events()), 1)


if __name__ == "__main__":
    unittest.main()
