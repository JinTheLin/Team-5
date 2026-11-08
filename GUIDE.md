# Pocket Miracle guide

This guide covers everything from a fresh clone to a working demo: setting up the laptop, flashing the cane, running the app, what every screen does, caretaker mode, and what to check when something breaks. If you only want the short version, the [README](README.md) has a quick start.

Everything here assumes a Mac. Most of it works on Windows or Linux too, but the voice clip script and the `say` option in the simulated cane use macOS text to speech.

## Contents

1. [What you need](#1-what-you-need)
2. [One-time laptop setup](#2-one-time-laptop-setup)
3. [Flashing the cane](#3-flashing-the-cane)
4. [Starting everything](#4-starting-everything)
5. [Using the cane on its own](#5-using-the-cane-on-its-own)
6. [Connecting the cane to the app](#6-connecting-the-cane-to-the-app)
7. [Testing without the cane](#7-testing-without-the-cane)
8. [When does the cane speak?](#8-when-does-the-cane-speak)
9. [The app, screen by screen](#9-the-app-screen-by-screen)
10. [Caretaker mode](#10-caretaker-mode)
11. [Checking that everything works](#11-checking-that-everything-works)
12. [Troubleshooting](#12-troubleshooting)
13. [Known limits](#13-known-limits)

## 1. What you need

Hardware (only for the real cane):

- Freenove ESP32-S3 camera board (set up as `CAMERA_MODEL_ESP32S3_EYE`)
- HC-SR04 ultrasonic sensor
- A small speaker and a resistor
- A limit switch, used as the cane's only button
- A USB cable to flash the board
- An iPhone (or any phone) to run a hotspot

Wiring, from the top of `Hardware/esp32/CameraWebServer.ino`:

| Part | Pin |
|---|---|
| HC-SR04 TRIG | GPIO 21 |
| HC-SR04 ECHO | GPIO 14 |
| Speaker red (through the resistor) | GPIO 47 |
| Speaker black | GND |
| Limit switch COM / NO | GND / GPIO 42 |

The camera uses GPIO 4 to 13 and 15 to 18, and the voice output uses GPIO 2. Don't wire anything else to those.

Software:

- Python 3.12. The Python that ships with macOS (3.9) is too old. `brew install python@3.12` fixes that.
- Node.js 20.19 or newer
- Arduino IDE 2 with the "esp32 by Espressif Systems" board package (only for flashing)
- An account in the app. You make this yourself on the sign-up screen, and you need to confirm the email before you can log in.

## 2. One-time laptop setup

Clone the repo and set up Python:

```bash
git clone https://github.com/JinTheLin/Team-5.git
cd "Team-5/Pocket-Miracle/Computer Vision"
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Then the app:

```bash
cd ../App/frontend
npm install
```

The first time the laptop service starts a run, it downloads the stock YOLO model (`yolo11n.pt`, about 5 MB), so be on the internet for that. Our own door and stairs model is already in the repo at `Computer Vision/models/door_stairs.pt`.

You don't need to set up Supabase. The project URL and public key are already in `App/frontend/src/supabase-config.json`. If you ever point the app at a different Supabase project, read `App/frontend/AUTH.md` first.

## 3. Flashing the cane

You only need to do this when the firmware changes.

1. Arduino IDE wants a sketch to sit in a folder with the same name as the `.ino` file. Make a folder called `CameraWebServer` and copy everything from `Pocket-Miracle/Hardware/esp32/` into it, including the `src/` folder. You can leave out `CameraWebServer1/` (an older copy of the sketch without voice or mute) and `voice/`.
2. In that folder, copy `secrets.example.h` to `secrets.h` and put in your hotspot's name and password. `secrets.h` is ignored by git, so your password stays on your laptop.
3. Open `CameraWebServer.ino` in Arduino IDE.
4. In the Tools menu, set:
   - Board: ESP32S3 Dev Module
   - PSRAM: OPI PSRAM
   - Flash Size: 8MB
   - Partition Scheme: 8M with spiffs (3MB APP), or Huge APP
   - USB CDC On Boot: Enabled
5. Plug in the board, pick its port and click Upload.
6. Open the Serial Monitor at 115200 baud. Once it joins the hotspot it prints a line like `Camera Ready! Use 'http://172.20.10.3'`. That address is what you'll type into the app.

The voice clips are already built into `src/voice_clips.cpp`. If you add new words to the watch list in `cane_logic.py`, regenerate them with `python3 Hardware/esp32/voice/make_clips.py --sketch /path/to/CameraWebServer` and upload again.

## 4. Starting everything

You need two terminals, plus a third if you're using the simulated cane instead of the real one. Run these from the `Team-5` folder.

Terminal 1, the laptop service. This is the part that runs detection, decides when to warn and handles caretaker mode.

```bash
cd "Pocket-Miracle/Computer Vision"
.venv/bin/python serve.py
```

It should say `Laptop vision service: http://127.0.0.1:8765`. It sits idle until you press Start in the app, so it won't open any camera on its own.

Terminal 2, the app:

```bash
cd Pocket-Miracle/App/frontend
npm run dev
```

Open http://localhost:8443 in Chrome or Safari.

Terminal 3, only without the real cane:

```bash
cd "Pocket-Miracle/Computer Vision"
.venv/bin/python sim_cane.py --say
```

To stop everything, press Ctrl+C in each terminal. Closing the browser tab doesn't stop a detection run. Press Stop detection in the app, or Ctrl+C the laptop service.

## 5. Using the cane on its own

The cane starts asleep when it powers up. The sonar and speaker are off.

- To turn it on, hold the switch for 2 seconds. You'll hear a rising chime.
- To turn it off, hold the switch for 2 seconds again. You'll hear a falling chime.
- To mute it while it's on, tap the switch twice quickly. It says "Speaker muted". Tap twice again to unmute. Turning the cane off and on also unmutes it.

While it's on, the sonar checks what's in front of you about 16 times a second. Past 120 cm it stays quiet. Closer than that it beeps, and the beeps get faster and louder as you get closer. Under 30 cm it plays a solid tone. That solid tone still plays when muted, on purpose.

None of this needs WiFi or the laptop. If the cane never connects to the hotspot, you still get the beeper.

## 6. Connecting the cane to the app

1. Turn on the phone hotspot. On an iPhone, turn on Maximize Compatibility, since the ESP32 only does 2.4 GHz.
2. Power the cane and wait for the Serial Monitor to print its address.
3. Connect the laptop to the same hotspot. Campus WiFi won't work, because the laptop and cane have to be on the same network.
4. Turn the cane on (hold the switch 2 seconds). The sonar only runs while it's on.
5. In the app, go to the Camera tab and choose Physical cane. Type the cane's address, for example `172.20.10.3`.
6. Leave "Send qualifying warnings to the cane speaker" ticked if you want the cane to talk.
7. Press Start cane detection.

After a few seconds you'll see the cane's video with boxes drawn around what the model found. Under the video you'll see the list of detected objects, the sonar distance and the last warning. When a warning goes out, the cane says it, and the app says it too if Voice announcements is on in Settings. The cane's speaker is pretty quiet, which is why the app repeats it.

Press Stop detection when you're done. That frees the camera for the next person. Only one account can run detection at a time, because there's only one cane.

## 7. Testing without the cane

There are two options.

### Simulated cane

`sim_cane.py` answers exactly like the real firmware, so the laptop service can't tell the difference. Start it (terminal 3 above), then in the Camera tab choose Physical cane and type `127.0.0.1:8080`.

By default it uses your laptop webcam as the cane camera. You can also feed it a folder of photos or a video:

```bash
.venv/bin/python sim_cane.py --source test_images/ --say     # cycles through the door and stairs photos
.venv/bin/python sim_cane.py --source walk.mp4
```

You can control the fake sonar from any browser tab while it runs:

| Open this | What it does |
|---|---|
| `http://127.0.0.1:8080/sim?cm=60` | pretend something is 60 cm away |
| `http://127.0.0.1:8080/sim?cm=none` | nothing in range |
| `http://127.0.0.1:8080/sim?on=0` | switch the cane off (`on=1` to turn it back on) |
| `http://127.0.0.1:8080/sim` | show the current state, what the beeper would be doing, and everything the cane has said |

With `--say`, the laptop speaks whatever the cane would have said. Without it, the terminal prints `CANE SAYS: ...` instead.

### Laptop webcam

In the Camera tab choose Laptop webcam and press Start webcam test. Tick "Simulate distance to test warning rules" and pick a distance if you want to see warnings. Webcam runs never send anything to a cane.

Both options need macOS to allow camera access for whatever app you run Python from (Terminal or VS Code): System Settings → Privacy & Security → Camera.

## 8. When does the cane speak?

We tuned this to stay quiet unless something matters. A warning goes out only when all of these are true:

1. The model sees something on the watch list and is at least 75% sure. You can change the 75% in Settings → Detection thresholds → Warning confidence.
2. It's straight ahead, meaning the middle of its box is in the middle band of the picture, where the sonar points.
3. It showed up in at least 2 of the last 3 frames. A single bad frame won't set it off.
4. The sonar says it's closer than 150 cm. You can change that in Settings → Warning distance. The distance always comes from the sonar, not the camera, and it gets rounded down, so 147 cm is said as "one meter".
5. It hasn't already been said. Each kind of object is announced once, then again only if it gets closer ("one meter" to "less than one meter"). If it's gone for 3 seconds, it counts as new next time.

Stairs are the exception. A sonar pointing forward gets no echo from a drop, so stairs are announced from the camera alone, without a distance: "Stairs ahead. Caution."

The watch list is person, dog, chair, dining table, couch, bench, bed, toilet, potted plant, suitcase, bicycle, motorcycle, car, bus, truck, fire hydrant, door and stairs. Doors and stairs come from our own model. The stock YOLO model doesn't know them. Curb is on the list, but nothing detects curbs yet.

Threshold changes apply the next time you press Start, not to a run that's already going.

More detail, including how the door/stairs model was trained and how well it does, is in [Computer Vision/README.md](Pocket-Miracle/Computer%20Vision/README.md).

## 9. The app, screen by screen

The app is laid out like a phone app, with four tabs along the bottom and a settings button at the top of Home.

### Sign up and log in

New users make an account with a name, email and password. Supabase sends a confirmation email, and you have to click that link before you can log in. Each account has its own settings and history.

### Home

- The cane card at the top shows whether detection is running.
- Safety and Cane camera are shortcuts to those tabs. The camera card shows a small live preview while a run is going.
- Fall detection is shown but not connected yet.
- Emergency help opens the SOS sheet. From there you can send an SOS to your caretaker, or call your emergency contact. See [section 10](#10-caretaker-mode).

### Safety

- After you send an SOS, the map area shows a link to the location you sent.
- The rows below show your linked caretaker, your emergency contact and when you last sent an SOS.
- SOS Emergency Assistance does the same thing as Emergency help on Home.

### Camera

This is where you start and stop detection (sections 6 and 7). Pick Physical cane or Laptop webcam, fill in the address or the simulated distance, and press Start. While it runs you see the labelled video, what was detected, whether each thing is ahead or off to the side, the sonar reading and the last warning.

### History

Every run is saved to your account: when it ran, what it saw and which warnings went out. To count as a sighting, an object on the watch list has to show up in 3 of 5 frames at 70% or more. A chair that stays in view is one entry that keeps getting updated, not one entry per frame. No images or video leave the laptop. Only the text gets saved.

If the laptop loses internet in the middle of a run, the history waits in a queue on the laptop and uploads the next time you're online and logged in.

### Settings

Under Experience:

- Voice announcements: whether warnings are spoken, by the cane and by the app.
- Alert volume: saved to your account, but it doesn't change the cane's volume yet.
- Accessibility: larger text and reduced motion.

Under Connections & trust:

- Cane connection: a preview of Bluetooth pairing. It doesn't actually pair anything yet.
- Automatic reconnection: saved preference.
- Emergency contact: a name and phone number for the Call button on the SOS screen.
- Trusted caretaker: link or remove a caretaker (section 10).

Caretaker mode switches this account into the caretaker view. Use it on the caretaker's account, not on the cane user's account.

Detection thresholds are the warning distance and confidence from section 8.

Settings save on their own after you change them. At the bottom you'll see "Preferences saved to your account", and the Log out button.

## 10. Caretaker mode

The idea: someone who looks after the cane user (a parent, a friend) links their own account to the cane user's account. After that they get the SOS alerts and can ask to see the camera. The cane user stays in control of the camera the whole time.

For now both accounts have to be on the same laptop, because the laptop service only accepts connections from that laptop. For a demo, open the caretaker in a private or incognito window (Cmd+Shift+N). It has to be a private window, since a normal second tab would share the same login.

### Linking

1. Cane user: Settings → Trusted caretaker → Create link code. The app shows a 6-digit code and reads it out loud. "Read code aloud" repeats it. The code works once and expires after 10 minutes.
2. Caretaker, in the private window: log in with a different account, then go to Settings and turn on Caretaker mode.
3. Caretaker: Home now says "Link to someone". Type the code and press Link. The browser may ask to allow notifications. Say yes, so SOS alerts can pop up.

Five wrong codes in a row lock the caretaker out of linking for 5 minutes.

People show up by the first part of their email address. If the caretaker's email is `maya.chen@gmail.com`, the cane user sees "maya.chen".

### Asking to see the camera

1. Caretaker: Camera tab → Ask to see their camera.
2. Cane user: a card pops up on whatever screen they're on, and the app says "maya.chen wants to see your camera. Choose Allow, or Not now."
3. If they allow it, the caretaker sees the same labelled video, detections and sonar reading the cane user sees. The cane user gets a bar at the top saying who can see their camera, with a Stop button. A soft tone plays every 20 seconds as a reminder.
4. Sharing ends when either person presses Stop or End live view, when the cane user logs out, or after 10 minutes, whichever comes first.

The caretaker only sees video while the cane user has detection running. If sharing is allowed but the cane isn't running, the caretaker sees "Their camera is off".

### SOS

1. Cane user: Home → Emergency help → Send SOS (or Safety → SOS Emergency Assistance → Send SOS). The button stays greyed out until a caretaker is linked.
2. The browser asks for location. If you allow it, the location goes with the alert.
3. The app says "SOS sent to 1 caretaker with your location."
4. The caretaker's app says the alert out loud and shows a desktop notification if they allowed notifications. The alert shows up on their Home and Safety tabs, with an "Open location on map" link (OpenStreetMap) and how accurate the location is.
5. An SOS also starts live view right away, without asking, so the caretaker can see what's going on. It ends after 10 minutes like a normal live view, and the cane user can still press Stop.

### Emergency contact

This is separate from the caretaker. Set a name and phone number in Settings → Emergency contact. The SOS sheet then shows a "Call (name)" button. That button only opens the phone dialer (on a Mac, usually FaceTime or your iPhone). It doesn't place the call for you.

### Removing a caretaker

- The cane user can go to Settings → Trusted caretaker and press Remove.
- The caretaker can go to Safety and press "Stop being (name)'s caretaker".

Links are saved on the laptop in `Computer Vision/data/care_links.json`, so they survive a restart. Alerts and live views are kept in memory, so restarting `serve.py` clears them.

## 11. Checking that everything works

### Automated tests

```bash
cd "Pocket-Miracle/Computer Vision"
.venv/bin/python -m unittest test_cloud test_history test_serve test_care test_sim_cane   # about 10 s
.venv/bin/python -m unittest test_simulation                                              # about 30 s
```

Both should end with `OK`. The first set doesn't touch any hardware or the internet. The second set loads the real model and runs simulated walks against the fake cane. It checks that the cane stays quiet when things are far away, speaks once per distance step, doesn't repeat itself, stays quiet when switched off, recovers if the cane drops off WiFi, and announces doors and stairs.

To make sure the app still compiles:

```bash
cd Pocket-Miracle/App/frontend
npx tsc --noEmit -p . && npm run build
```

### By hand

With the three terminals running (section 4) and the simulated cane:

- [ ] Change a setting, close Settings and reload the page. The change should still be there.
- [ ] Save an emergency contact in Settings. You should see "Emergency contact saved."
- [ ] Camera tab → Physical cane → `127.0.0.1:8080` → Start cane detection. Video with boxes shows up.
- [ ] Open `http://127.0.0.1:8080/sim?cm=60` and stand in front of the webcam. The warning gets spoken by the laptop and by the app.
- [ ] Create a link code. It gets read out loud.
- [ ] In a private window, log in with a second account, turn on Caretaker mode and enter the code.
- [ ] Caretaker asks to see the camera. Cane user presses Allow. The caretaker sees the video, and the cane user hears the tone and sees the Stop bar.
- [ ] Cane user sends an SOS and allows location. The caretaker hears the alert, and the map link opens the right spot.
- [ ] Check the History tab for the run you just did.

Then swap the simulated cane for the real one (section 6) and do the camera and warning checks again.

## 12. Troubleshooting

### The app says "Laptop service offline"

Terminal 1 isn't running or has crashed. Look at it for an error and start `serve.py` again.

### The app sits on "Waiting for the camera" with the real cane

Usually it's the network. Check these in order:

- The laptop is on the cane's hotspot, not campus WiFi.
- The Mac has a `172.20.10.x` address (`ipconfig getifaddr en0`). If it's blank or `192.0.0.2`, the hotspot gave the Mac only an IPv6 address, which some carriers do. Fix it once in System Settings → Wi-Fi → Details next to the hotspot → TCP/IP → Configure IPv6: Link-local only, then turn Wi-Fi off and on. Quick fix for one session: `sudo ifconfig en0 alias 172.20.10.14 255.255.255.240`.
- macOS might be blocking it. Turn on Terminal or VS Code in System Settings → Privacy & Security → Local Network, then restart the terminal.
- The ESP32 streams to one viewer at a time. Close any browser tab or `test_stream.py` window that has the cane's stream open.
- Try opening `http://<cane ip>/capture` in the browser. If that doesn't load either, the laptop can't reach the cane at all.

### "Preferences not saved: Could not find the 'emergency_contact_name' column"

The database is missing the emergency contact columns. Someone with access to the Supabase project needs to run this in the SQL editor:

```sql
alter table public.app_settings
  add column if not exists emergency_contact_name text,
  add column if not exists emergency_contact_phone text;
```

### "No custom model at ... doors and stairs won't be detected"

`Computer Vision/models/door_stairs.pt` is missing. Pull again, or check that it didn't get deleted. Everything else still works without it.

### "Could not open 0 (check Camera permission for a webcam)"

Allow camera access for Terminal or VS Code in System Settings → Privacy & Security → Camera, then restart the terminal.

### "Address already in use" when starting serve.py or sim_cane.py

An old copy is still running. Find it with `lsof -i :8765` (or `:8080` for the simulated cane) and stop it. Or start the simulated cane on another port with `--port 9090` and type `127.0.0.1:9090` in the app.

### "The shared camera is currently in use"

Another account has a run going. Wait for it to stop, or stop it from that account.

### Can't log in after signing up

Click the link in the confirmation email first. Check spam.

### The app shows warnings but the cane stays quiet

Check that the cane is on (hold the switch 2 seconds), that "Send qualifying warnings to the cane speaker" was ticked before pressing Start, and that Voice announcements is on in Settings. You can test the speaker directly by opening `http://<cane ip>/warn?msg=chair,0.9` in a browser.

### Arduino says the sketch has to be in a folder called CameraWebServer

See step 1 of [section 3](#3-flashing-the-cane).

## 13. Known limits

- Bluetooth pairing and fall detection are placeholders in the UI. The cane talks to the laptop over WiFi.
- Curbs aren't detected. To add them, take a few hundred photos with the cane camera (`test_stream.py`, press `s` to save a frame), label them, and retrain. The steps are in the Computer Vision README.
- The door and stairs model was trained on regular photos, not cane camera images, so it's less accurate on the cane than on the test pictures. Big doors and stairs straight ahead work best. Small or far-away doors get missed a lot.
- Caretaker mode only works on the same laptop for now. Moving the links and alerts into Supabase would let the caretaker use their own phone.
- The volume slider doesn't reach the cane yet.
