# Pocket Miracle smart cane

Pocket Miracle is a smart cane for people who are blind or have low vision. The cane has a sonar sensor that beeps faster as you get closer to something, and a small camera that streams to a laptop. The laptop runs object detection on the video. When it sees something in your way (a chair, a person, a door, stairs), it tells the cane, and the cane says it out loud: "Chair, less than one meter. Caution."

There is also a web app. The person using the cane can watch what the camera sees, look back at past warnings, and send an SOS. A family member or caretaker can link to them from a second account. That account gets the SOS alerts and can ask to see the cane camera, and the cane user has to say yes first.

If you just want to get it running, go to [GUIDE.md](GUIDE.md). It walks through setup, every screen in the app, caretaker mode, testing and troubleshooting.

## How the pieces fit together

```
  Smart cane (ESP32-S3)                 Laptop                              Browser
  ---------------------                 ------                              -------
  camera  -- video (port 81) ------->   serve.py                            React app
  sonar   -- /distance ------------->   YOLO detection + warning rules <--> (localhost:8443)
  speaker <-- /warn?msg=chair,0.9 ---   caretaker links, SOS, live view     user + caretaker
                                              |
                                              v
                                        Supabase (accounts, settings, history)
```

The cane does three jobs: stream video, measure distance, and talk. All of the detection happens on the laptop. The cane still works without the laptop. It just goes back to sonar beeps only.

## What works right now

- Sonar beeper on the cane, with on/off (hold the switch 2 seconds) and mute (double tap)
- Live camera feed from the cane into the app, with detected objects outlined
- Spoken warnings on the cane speaker, and in the app's browser voice too
- A custom model for doors and stairs, running next to the stock YOLO model
- Accounts, saved settings and a history of past warnings (Supabase)
- Caretaker mode: link code (the app reads it out loud), SOS with location and map link, live view with approval
- Emergency contact with a "Call" button
- A simulated cane, so you can test everything without the hardware

Still not done:

- Bluetooth pairing is a preview screen only. The cane talks to the laptop over WiFi.
- Fall detection is not connected.
- Curbs aren't detected. We couldn't find a public labelled curb dataset, so this needs our own photos.
- The caretaker has to use the same laptop as the cane user for now (a second browser window). Links are saved on that laptop, not in the cloud.
- The volume slider is saved but doesn't change the cane's volume yet.

## Folder layout

```
Pocket-Miracle/
  App/
    frontend/            React + Vite app (the phone-style UI)
      src/App.tsx        tabs, settings, SOS
      src/care.tsx       caretaker mode (linking, live view, SOS alerts)
      src/vision.tsx     talks to the laptop service, speaks warnings
      AUTH.md            how accounts and Supabase are set up
    backend/             empty for now
  Computer Vision/
    serve.py             the laptop service the app talks to
    cane_logic.py        when to warn and what to say
    care.py              caretaker links, SOS alerts, live view rules
    sim_cane.py          fake cane for testing without hardware
    test_stream.py       older command-line tool, still handy for debugging the cane
    models/door_stairs.pt  our door + stairs model
    training/            script that builds the door/stairs dataset
    README.md            details on the warning rules and the model
  Hardware/
    esp32/               Arduino sketch for the cane (camera, sonar, beeper, voice)
      voice/             voice clips and the script that makes them
```

## Quick start

You need a Mac with Python 3.12 and Node.js 20.19 or newer. Full steps are in [GUIDE.md](GUIDE.md).

```bash
# once
cd "Pocket-Miracle/Computer Vision"
python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
cd ../App/frontend && npm install

# every time (three terminals)
cd "Pocket-Miracle/Computer Vision" && .venv/bin/python serve.py        # laptop service
cd Pocket-Miracle/App/frontend && npm run dev                           # app at http://localhost:8443
cd "Pocket-Miracle/Computer Vision" && .venv/bin/python sim_cane.py --say   # only if you don't have the cane
```

Then open http://localhost:8443, make an account, go to the Camera tab, pick "Physical cane" and type the cane's address (or `127.0.0.1:8080` for the simulated one).

## Tests

```bash
cd "Pocket-Miracle/Computer Vision"
.venv/bin/python -m unittest test_cloud test_history test_serve test_care test_sim_cane   # about 10 s
.venv/bin/python -m unittest test_simulation                                              # about 30 s
```

The second set runs the real model against the simulated cane: it walks toward obstacles and checks that the cane speaks when it should and stays quiet when it shouldn't.

## More docs

- [GUIDE.md](GUIDE.md): setup and how to use everything
- [Pocket-Miracle/Computer Vision/README.md](Pocket-Miracle/Computer%20Vision/README.md): warning rules, the door/stairs model, retraining, cane network problems
- [Pocket-Miracle/App/frontend/AUTH.md](Pocket-Miracle/App/frontend/AUTH.md): accounts, Supabase setup, who can see what
