# Computer Vision

Python prototyping for the cane's camera mode: read the ESP32 video, run YOLO, and later train our own door / stairs / curb model. Only the final exported model goes into the app.

## One-time setup (Mac)

```bash
brew install python@3.12            # macOS's built-in Python 3.9 is too old
cd "Pocket-Miracle/Computer Vision"
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run `source .venv/bin/activate` again in every new terminal. The YOLO weights (`yolo11n.pt`, 5 MB) download automatically on the first run.

## test_stream.py: camera + sonar → warning, end to end

1. Turn on the iPhone hotspot (Maximize Compatibility ON) and power the cane.
2. Join the **same hotspot** with the laptop.
3. Get the cane's IP from the Arduino Serial Monitor (`Camera Ready! Use 'http://172.20.10.x'`).
4. **Hold the cane's switch 2 s to turn it on.** The sonar only runs while the cane is on.
5. Run:

```bash
python test_stream.py 172.20.10.3            # cane video + sonar
python test_stream.py 172.20.10.3 --say      # also speak the warnings on the laptop
python test_stream.py 172.20.10.3 --capture  # fallback: single photos in a loop
python test_stream.py 0 --sonar-cm 80        # laptop webcam + pretend sonar distance
```

| Key | Action |
|---|---|
| `q` / `Esc` | quit |
| `s` | save the raw frame to `data/raw/` (use this to collect training images) |
| `p` | pause / resume |

### When does it warn?

The rules live in [cane_logic.py](cane_logic.py), kept free of camera/network code so they can be copied into the phone app. A warning is sent only when **all** of these are true:

1. The model sees an object on the `WATCH` list (person, chair, table, couch, bike, car, truck, … and later door / stairs / curb) and is **at least 75% sure** (`--warn-conf 0.75`). Edit `WATCH` to change the list.
2. It's **straight ahead**: the box center is inside the shaded middle band, where the sonar points.
3. Something on the list was ahead in **2 of the last 3 frames**, so a one-frame mistake doesn't trigger it. If the label flickers (chair / couch), the most common label wins.
4. The **sonar** reads closer than 150 cm. The distance always comes from the sonar, not the camera, and is rounded **down** (147 cm → `1.4` → "one meter").
5. **It hasn't been said yet.** Each kind of object (person, chair, …) is announced once, then again only when it gets **closer** ("one meter" → "less than one meter"). Backing off and coming back doesn't repeat it. Once it has been gone (or out of range) for 3 s (`--forget 3`), it counts as new again. Each object has its own memory, so a chair never silences a person who shows up next. If a warning doesn't reach the cane (WiFi hiccup), it's sent again.

The sonar beeper keeps beeping for close obstacles in between, so a quiet voice never means no warning at all.

**Exception: stairs and curbs.** A forward-facing sonar gets no echo from a drop (going down stairs, stepping off a curb), so these warn from the camera alone, without a distance: `stairs` → "Stairs ahead. Caution." They have their own memory, so a chair warning never blocks a stairs warning. This only kicks in once our custom model can detect them.

The message is `object,meters` (e.g. `chair,0.9`), or just `stairs` / `curb`. The laptop:
- sends it to the cane (`http://<ip>/warn?msg=chair,0.9`) and **the cane says it** ("Chair, less than one meter. Caution."). Turn off with `--no-cane-voice`.
- prints it and shows a red banner.
- with `--say`, also speaks it on the laptop.

You can test the cane's voice without the laptop script: turn the cane on and open `http://172.20.10.3/warn?msg=chair,0.9` in a browser.

If the video stops, the window shows **NO VIDEO** and no warnings are made until it comes back. Paused (`p`) also means no warnings.

Box colors: **red** = watched, 75%+ sure and straight ahead; **green** = watched but off to the side; **gray** = not on the watch list or under 75%.

Tuning: `--warn-conf 0.75`, `--warn-cm 150`, `--forget 3`, `--center 0.3`. If real objects rarely reach 75% on the low-res cane camera, try `--warn-conf 0.6`.

### Sonar distance from the cane

The cane firmware serves its latest sonar reading at `http://<ip>/distance`:

```text
{"on": true, "cm": 85.3}    cane on, something in range
{"on": true, "cm": null}    cane on, nothing in range
{"on": false, "cm": null}   cane off (sleep mode)
```

This needs the updated `Hardware/esp32/app_httpd.cpp`. If the screen says "cane has no /distance yet", upload the sketch again. On the phone this distance will come over Bluetooth instead (`dist,85`).

### If the window says "Waiting for video"

- The laptop isn't on the cane's hotspot (campus WiFi won't work).
- **Mac has no `172.20.10.x` address** (check with `ipconfig getifaddr en0`; `192.0.0.2` or blank is wrong). Some carriers (e.g. T-Mobile) make the hotspot give the Mac only an IPv6 address, so it can't reach the cane. Fix once: System Settings → Wi-Fi → Details… next to the hotspot → TCP/IP → Configure IPv6: **Link-local only**, then turn Wi-Fi off and on. Quick one-session fix instead: `sudo ifconfig en0 alias 172.20.10.14 255.255.255.240`.
- macOS is blocking it: System Settings → Privacy & Security → **Local Network** → turn on Terminal / VS Code. Then restart the terminal.
- **Safari on the phone has the stream open.** The ESP32 serves the stream to one viewer at a time. Close the tab, or use `--capture`.
- Check that `http://<ip>/capture` opens in the laptop's browser.

## What to expect

The stock model is trained on COCO (80 everyday classes: person, chair, car, bicycle, …). **It does not know door, stairs or curb**, so this test only proves the pipeline. The cane camera (GC0308) gives 320×240 frames at a few fps; on an M2 the model takes about 10–15 ms per frame, so the camera is the bottleneck.

## Next steps

1. **Collect cane images:** walk around with `test_stream.py` and press `s` at doors, stairs and curbs from different distances and lighting. The low-res cane images look different from phone photos, so we need a few hundred of these.
2. **Public data:** find labeled door / stairs / curb datasets on Roboflow Universe and merge them with our images in one Roboflow project (label our captures there too).
3. **Train** a YOLO nano model on that dataset (`train.ipynb`, coming next).
4. **Export** to Core ML for the iPhone and put it in `App/frontend/assets/models/`.

`data/`, `.venv/` and `*.pt` are git-ignored. Share images through Roboflow, not git.
