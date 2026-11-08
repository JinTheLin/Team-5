# Computer Vision

## Run recognition inside the laptop app

The React Camera tab can now control the Python pipeline and show its real
detections, annotated images, sonar readings, and last warning.

1. Install the Python dependencies: `python -m pip install -r requirements.txt`.
2. From `App/frontend`, run `npm run vision` in one terminal and `npm run dev`
   in another. If the UI is already running, leave it running.
3. Sign up or log in, then open the app's Camera tab. Choose **Physical cane**, enter its hotspot IP,
   and press **Start cane detection**. The laptop must share its network.
4. Without the cane, choose **Laptop webcam** and press **Start webcam test**.
   Optionally enable simulated distance to exercise warning thresholds. This
   value is explicitly simulated; webcam tests never send warnings to a cane.
5. Press **Stop detection** to release the camera. Switching UI tabs does not
   stop detection. Closing the browser does not stop it either; use Stop or
   Ctrl+C in the Python terminal when finished.

`python serve.py` from this folder is equivalent to `npm run vision`. The
service binds to `127.0.0.1:8765` and remains idle until started from the app.
Only local browser origins can control it. The model downloads on first start;
loading/dependency errors are shown in the app. Custom weights can be supplied
with `python serve.py --model path/to/model.pt`.

The API requires your Supabase access token; it verifies identity through
Supabase Auth and never accepts a user ID supplied by the browser. Live camera
results are visible only to the account that started the run. Everyone uses
the same physical cane, one run at a time, without permanent cane ownership.

Sessions, grouped sightings, and warning decisions sync to that account's
Supabase history. Uploads run separately from inference. If uploads fail, a
SQLite outbox in `data/history_queue.sqlite3` retains them until the same user
reconnects. Tokens are held in memory, not stored in the outbox. No images or
video are uploaded. Log out or use Stop detection to end your run.

Project URL and publishable key are shared with the frontend in
`App/frontend/src/supabase-config.json`. To use another project, change that
file, or set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` for Python along with
the frontend's corresponding `VITE_` overrides. Do not use a service-role key.

Account setup and email redirect requirements are in `App/frontend/AUTH.md`.

Python alone opens the ESP32 stream; the UI retrieves processed JPEGs from
Python, avoiding a second competing connection to the cane. Close other direct
camera viewers (including `test_stream.py`) before starting.

Hardware-free API/inference-loop checks: `python -m unittest test_serve -v`.
These use fake input/model output, not physical camera measurements. Existing
threshold rules in `cane_logic.py` are reused unchanged. The stock YOLO model
does not detect doors, stairs, or curbs.

This integration runs in the laptop browser with the local Python service.
No Android Studio, Xcode, or mobile packaging dependencies are needed.

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

1. The model sees an object on the `WATCH` list (person, chair, table, couch, bike, car, truck, …, plus door and stairs from our model) and is **at least 75% sure** (`--warn-conf 0.75`). Edit `WATCH` to change the list.
2. It's **straight ahead**: the box center is inside the shaded middle band, where the sonar points.
3. Something on the list was ahead in **2 of the last 3 frames**, so a one-frame mistake doesn't trigger it. If the label flickers (chair / couch), the most common label wins.
4. The **sonar** reads closer than 150 cm. The distance always comes from the sonar, not the camera, and is rounded **down** (147 cm → `1.4` → "one meter").
5. **It hasn't been said yet.** Each kind of object (person, chair, …) is announced once, then again only when it gets **closer** ("one meter" → "less than one meter"). Backing off and coming back doesn't repeat it. Once it has been gone (or out of range) for 3 s (`--forget 3`), it counts as new again. Each object has its own memory, so a chair never silences a person who shows up next. If a warning doesn't reach the cane (WiFi hiccup), it's sent again.

The sonar beeper keeps beeping for close obstacles in between, so a quiet voice never means no warning at all.

**Exception: stairs and curbs.** A forward-facing sonar gets no echo from a drop (going down stairs, stepping off a curb), so these warn from the camera alone, without a distance: `stairs` → "Stairs ahead. Caution." They have their own memory, so a chair warning never blocks a stairs warning. Stairs come from our model (`models/door_stairs.pt`); curbs are not detected yet.

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

## The MVP demo: app + laptop + cane

The laptop does the detection; the cane streams video, measures distance and speaks. Three terminals:

```bash
# 1. laptop vision service (YOLO + warning rules + caretaker link)
cd "Pocket-Miracle/Computer Vision" && source .venv/bin/activate && python serve.py
# 2. the app
cd Pocket-Miracle/App/frontend && npm install && npm run dev        # http://localhost:8443
# 3. only without the real cane: the simulated cane
cd "Pocket-Miracle/Computer Vision" && source .venv/bin/activate && python sim_cane.py --say
```

Log in, open **Camera**, choose **Physical cane** and enter the cane's address:
- real cane: the IP from the Serial Monitor, e.g. `172.20.10.3` (hold the switch 2 s to turn it on)
- simulated cane: `127.0.0.1:8080`

Press **Start cane detection**. The app shows the labelled video, the sonar distance and every warning; the cane speaks the warning.

## Simulated cane (sim_cane.py)

Answers exactly like the firmware (`/distance`, `/warn`, `/stream` on the next port), so the laptop and app can't tell the difference. Video comes from the webcam, a video file, or a folder of pictures:

```bash
python sim_cane.py                          # laptop webcam is the cane camera
python sim_cane.py --source photos/ --say   # loop through pictures, speak warnings out loud
```

Move the pretend obstacle and switch the cane while it runs (in a browser or with curl):

```text
http://127.0.0.1:8080/sim?cm=60     obstacle at 60 cm        (cm=none: nothing in range)
http://127.0.0.1:8080/sim?on=0      cane switched off        (on=1: back on)
http://127.0.0.1:8080/sim           state, what the beeper would do, everything the cane said
```

## Caretaker mode

One app, two modes. A second account switches **Settings → Caretaker mode** on.

1. User: **Settings → Trusted caretaker → Create link code** (6 digits, works once, 10 minutes).
2. Caretaker: enter the code on Home. Five wrong codes lock linking for 5 minutes.
3. Caretaker **Camera → Ask to see their camera**. The user gets Allow / Not now on whatever screen they are on.
   Allowed: the caretaker sees the labelled cane video and detections; the user sees a "can see your camera" bar,
   hears a tone every 20 s and can **Stop** at any time. It ends by itself after 10 minutes.
4. User **Emergency help → Send SOS** (Home or Safety): the caretaker gets the alert with the user's location
   (if the browser allows it), a desktop notification, and the live view opens without asking, as the project plan says.

Links live on the laptop in `data/care_links.json`; alerts and live views are in memory. For the demo, open the caretaker
in a second browser window (or a private window) on the same laptop, since the laptop service only accepts the app on localhost.

## Door and stairs model (models/door_stairs.pt)

The stock model is trained on COCO (people, furniture, vehicles) and **doesn't know doors or stairs**. `models/door_stairs.pt`
is a YOLO11n fine-tuned on doors and stairs. `serve.py` loads it automatically next to the stock model and merges the detections,
so `door` and `stairs` warnings use the same rules as everything else (stairs warn without a distance, since a drop gives no echo).

Trained on 4,947 images (about 2,500 each with doors and stairs) from Open Images V7, human-labelled.
Results on 1,192 held-out images it never trained on (imgsz 320):

| Class | Precision | Recall | mAP50 |
|---|---|---|---|
| door | 0.60 | 0.43 | 0.48 |
| stairs | 0.68 | 0.58 | 0.59 |
| stairs, 306 pedestrian-view photos from the ROD dataset (not used for training) | 0.84 | 0.55 | 0.58 |

When it says "door" or "stairs" it's usually right; it misses a fair number, especially small or distant doors
(recall is per labelled box, and Open Images labels many background doors). Big doors and stairs straight ahead,
which are what the cane warns about, do much better: both test pictures in `test_images/` are found at 85-97%.
These are normal photos, not cane-camera images, so expect lower numbers on the cane until it's retrained with cane photos.

**Curbs are not detected.** We found no public, human-labelled curb boxes that can be downloaded without an account.
To add curbs: label a few hundred cane photos (`test_stream.py`, key `s`) in Roboflow, add them as class 2 to the dataset and retrain.

Retrain:

```bash
pip install pillow
python training/build_dataset.py data/        # needs data/oi/*.boxes.csv, see the script's header
yolo detect train model=yolo11n.pt data=data/cane_ds/data.yaml imgsz=320 epochs=40 batch=32 device=mps
cp runs/detect/train/weights/best.pt models/door_stairs.pt
```

## Tests

```bash
python -m unittest test_cloud test_history test_serve test_care test_sim_cane -v   # ~10 s, no hardware
python -m unittest test_simulation -v                                               # ~1 min, real model + simulated cane walks
```

`test_simulation` walks toward an obstacle and checks that the cane is quiet when far, speaks once per distance band,
repeats only when closer, stays quiet when switched off, recovers when the cane drops off WiFi, and announces stairs and doors.

`data/`, `.venv/` and `*.pt` are git-ignored (except `models/*.pt`). Share images through Roboflow, not git.
