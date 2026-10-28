"""
Decides when the cane should speak a warning.

A warning is sent only when ALL of these are true:
  1. The camera sees an object on the WATCH list (person, chair, table, ...)
     and is at least 75% sure about it (min_conf).
  2. The object is straight ahead: its box center is inside the middle band
     of the frame, which is where the sonar points.
  3. Something on the watch list was ahead in at least 2 of the last 3 frames
     (ignores one-frame mistakes).
  4. The sonar reading is fresh and closer than max_warn_cm.
     Exception: drop-offs (stairs, curb). A forward sonar gets no echo from a
     drop, so these warn from the camera alone, without a distance.
  5. It hasn't been announced yet. Each kind of object (person, chair, ...) is
     said once, then again only when it gets closer ("one meter" -> "less than
     one meter"). After it has been gone for forget_s seconds, it's new again.

The distance always comes from the sonar, not the camera.
The output is "object,meters" (e.g. "chair,0.9"), or just "object" for a
drop-off with no distance. That's the message the cane will receive over
Bluetooth. This file has no camera or network code, so the same rules can be
copied into the phone app.
"""

import math
from collections import Counter, deque
from dataclasses import dataclass
from typing import Optional

# Model class name -> word the cane says. Only these classes trigger warnings.
# Add or remove lines to change what the cane warns about.
WATCH = {
    # People and animals
    "person": "person",
    "dog": "dog",
    # Furniture and indoor obstacles
    "chair": "chair",
    "dining table": "table",
    "couch": "couch",
    "bench": "bench",
    "bed": "bed",
    "toilet": "toilet",
    "potted plant": "plant",
    "suitcase": "suitcase",
    # Outdoor obstacles
    "bicycle": "bicycle",
    "motorcycle": "motorcycle",
    "car": "car",
    "bus": "bus",
    "truck": "truck",
    "fire hydrant": "hydrant",
    # Our custom model (the pre-trained model can't see these yet)
    "door": "door",
    "stairs": "stairs",
    "curb": "curb",
}

# Classes the sonar can't measure (a drop has no echo). They warn without a distance.
DROP_OFFS = {"stairs", "curb"}

NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five"]
NO_DISTANCE = 99  # bucket used for warnings without a distance


@dataclass
class Detection:
    name: str     # class name from the model, e.g. "dining table"
    conf: float   # 0-1
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def area(self):
        return max(0.0, self.x1 - self.x0) * max(0.0, self.y1 - self.y0)


@dataclass
class Alert:
    word: str                # what the cane says, e.g. "table"
    meters: Optional[float]  # sonar distance (1 decimal), or None for "stairs ahead"

    @property
    def message(self):
        """What gets sent to the cane, e.g. 'chair,0.9' or 'stairs'."""
        if self.meters is None:
            return self.word
        return f"{self.word},{self.meters:.1f}"

    @property
    def sentence(self):
        """What the cane will say (matches the voice clip plan)."""
        word = self.word.capitalize()
        if self.meters is None:
            return f"{word} ahead. Caution."
        n = distance_bucket(self.meters)
        if n == 0:
            return f"{word}, less than one meter. Caution."
        if n == 1:
            return f"{word}, one meter. Caution."
        if n >= len(NUMBER_WORDS):
            return f"{word} ahead."  # no clip for bigger numbers (same as the cane)
        return f"{word}, {NUMBER_WORDS[n]} meters."


def to_meters(cm):
    """cm -> meters with 1 decimal, rounded DOWN (never sounds farther than it is).
    147 cm -> 1.4, 99.9 cm -> 0.9."""
    return math.floor(cm / 10) / 10


def distance_bucket(meters):
    """What the user hears: 0 = 'less than one meter', 1 = 'one meter', 2, 3 ...
    The cane uses the same rule on the meters it receives."""
    if meters < 1.0:
        return 0
    return int(meters + 0.5)


class WarningDecider:
    def __init__(self, center_band=0.3, max_warn_cm=150.0, min_conf=0.75,
                 confirm_frames=2, window=3, forget_s=3.0,
                 sonar_max_age_s=1.0, watch=None, drop_offs=None):
        self.center_band = center_band          # width of the "straight ahead" strip (0-1)
        self.max_warn_cm = max_warn_cm          # warn only when the sonar is closer than this
        self.min_conf = min_conf                # ignore detections the model is less sure about
        self.confirm_frames = confirm_frames    # needs this many of the last `window` frames
        self.forget_s = forget_s                # gone this long = next time is a new announcement
        self.sonar_max_age_s = sonar_max_age_s  # older sonar readings are ignored
        self.watch = WATCH if watch is None else watch
        self.drop_offs = DROP_OFFS if drop_offs is None else drop_offs
        self._recent = deque(maxlen=window)     # class name of the main object ahead, per frame
        self._said = {}                         # word -> (closest bucket said, last time seen ahead)
        self.status = ""                        # why we did / didn't warn (for the screen)

    def band(self, frame_w):
        """Left and right x of the straight-ahead strip, in pixels."""
        half = frame_w * self.center_band / 2
        return frame_w / 2 - half, frame_w / 2 + half

    def is_ahead(self, det, frame_w):
        x0, x1 = self.band(frame_w)
        return x0 <= det.cx <= x1

    def is_watched(self, det):
        return det.name in self.watch and det.conf >= self.min_conf

    def update(self, detections, frame_w, sonar_cm, sonar_time, now, cane_on=True):
        """Call once per new frame.

        detections: list of Detection
        frame_w:    frame width in pixels
        sonar_cm:   latest sonar distance, or None if nothing in range
        sonar_time: when that reading was taken (time.time()), or None if none yet
        now:        time.time()
        cane_on:    False while the cane is in sleep mode (never warns)

        Returns an Alert to send, or None.
        """
        ahead = [d for d in detections if self.is_watched(d) and self.is_ahead(d, frame_w)]
        # Several objects ahead: the biggest box is most likely the closest one,
        # i.e. the one the sonar is measuring.
        target = max(ahead, key=lambda d: d.area) if ahead else None
        self._recent.append(target.name if target else None)

        if target is None:
            self.status = ""
            return None

        # Name the object by majority over recent frames, so a label that
        # flickers (chair / couch / chair) doesn't turn into two warnings.
        counts = Counter(n for n in self._recent if n is not None)
        top = max(counts.values())
        name = target.name if counts[target.name] == top else counts.most_common(1)[0][0]
        word = self.watch[name]

        if sum(counts.values()) < self.confirm_frames:
            self.status = f"{word} ahead, confirming..."
            return None
        if not cane_on:
            self.status = f"{word} ahead, but the cane is off"
            return None

        fresh = sonar_time is not None and now - sonar_time <= self.sonar_max_age_s
        near = fresh and sonar_cm is not None and sonar_cm < self.max_warn_cm
        is_drop = name in self.drop_offs

        if near:
            meters = to_meters(sonar_cm)
        elif is_drop:
            meters = None  # "Stairs ahead": the sonar can't see a drop
        elif not fresh:
            self.status = f"{word} ahead, no sonar reading"
            return None
        elif sonar_cm is None:
            self.status = f"{word} ahead, sonar sees nothing in range"
            return None
        else:
            self.status = f"{word} ahead at {sonar_cm:.0f} cm (warn under {self.max_warn_cm:.0f})"
            return None

        # Say each object once, then again only when it gets closer. Each word
        # has its own memory, so a chair never silences a person that shows up
        # next. (The majority vote above keeps a flickering label from causing
        # more than one extra announcement.)
        bucket = NO_DISTANCE if meters is None else distance_bucket(meters)
        said = self._said.get(word)
        if said is not None and now - said[1] <= self.forget_s:
            closest, _ = said
            self._said[word] = (closest, now)  # still there: keep remembering it
            if bucket >= closest:
                self.status = f"{word} ahead (already said; again only if closer)"
                return None

        self._said[word] = (bucket, now)
        alert = Alert(word, meters)
        self.status = f"SENT {alert.message}"
        return alert

    def forget(self, word):
        """The warning for `word` didn't reach the cane: let it be sent again."""
        self._said.pop(word, None)
