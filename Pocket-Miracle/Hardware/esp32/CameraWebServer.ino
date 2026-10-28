/**********************************************************************
  Filename    : Camera Web Server
  Description : The camera images captured by the ESP32S3 are displayed on the web page.
  Auther      : www.freenove.com
  Modification: 2026/05/16
**********************************************************************/
#include "esp_camera.h"
#include <WiFi.h>
#include "board_config.h"
// ===================
// Select camera model
// ===================
//#define CAMERA_MODEL_WROVER_KIT // Has PSRAM
//#define CAMERA_MODEL_ESP_EYE // Has PSRAM
#define CAMERA_MODEL_ESP32S3_EYE // Has PSRAM
//#define CAMERA_MODEL_M5STACK_PSRAM // Has PSRAM
//#define CAMERA_MODEL_M5STACK_V2_PSRAM // M5Camera version B Has PSRAM
//#define CAMERA_MODEL_M5STACK_WIDE // Has PSRAM
//#define CAMERA_MODEL_M5STACK_ESP32CAM // No PSRAM
//#define CAMERA_MODEL_M5STACK_UNITCAM // No PSRAM
//#define CAMERA_MODEL_AI_THINKER // Has PSRAM
//#define CAMERA_MODEL_TTGO_T_JOURNAL // No PSRAM
// ** Espressif Internal Boards **
//#define CAMERA_MODEL_ESP32_CAM_BOARD
//#define CAMERA_MODEL_ESP32S2_CAM_BOARD
//#define CAMERA_MODEL_ESP32S3_CAM_LCD

#include "camera_pins.h"

/**********************************************************************
  Smart Cane - sonar beeper + power switch + camera stream
  Based on Freenove Camera Web Server (www.freenove.com)

  Power control:
    Starts in SLEEP mode (sonar + speaker off).
    Hold the limit switch 2 seconds -> turns ON  (rising chime).
    Hold the limit switch 2 seconds -> turns OFF (falling chime).

  Camera:
    Starts at boot. Connects to WiFi in the background.
    The cane works even if WiFi never connects.
    When connected, Serial Monitor prints the stream address.

  Wiring:
    HC-SR04 TRIG -> GPIO21
    HC-SR04 ECHO -> GPIO14
    GPIO47 -> resistor -> speaker red, speaker black -> GND
    Limit switch: COM -> GND, NO -> GPIO42
    Camera uses GPIO 4-13, 15-18 (don't wire anything else there)
    GPIO2: used by the voice output, don't wire anything there

  Voice (voice.cpp):
    The laptop/phone sends a warning to http://<ip>/warn?msg=chair,0.9
    and the cane says "Chair, less than one meter. Caution."
    Clips are stored in flash (src/voice_clips.cpp). Beeping pauses while talking.

  Tools menu: ESP32S3 Dev Module, PSRAM = OPI PSRAM, Flash = 8MB,
  Partition = 8M with spiffs (3MB APP) or Huge APP, USB CDC On Boot = Enabled
**********************************************************************/
#include "esp_camera.h"
#include <WiFi.h>
#include "board_config.h"   // camera model is chosen in this tab (CAMERA_MODEL_ESP32S3_EYE)
#include "voice.h"          // spoken warnings (shares the speaker with the beeper)

// ===========================
// WiFi credentials
// ===========================
// Set in secrets.h (not in git). Copy secrets.example.h to secrets.h to make your own.
#include "secrets.h"

// ===========================
// Cane pins
// ===========================
#define TRIG_PIN    21
#define ECHO_PIN    14
#define SPEAKER_PIN 47
#define SWITCH_PIN  42

// ---------- Tuning (change these to adjust the feel) ----------
const float ALERT_START_CM = 150.0;  // farther than this = silent
const float DANGER_CM      = 30.0;   // closer than this = solid tone

const int TONE_HZ        = 2000;     // beep pitch (small speakers are loudest around 2-3 kHz)
const int BEEP_MS        = 60;       // how long each beep lasts
const int SLOWEST_GAP_MS = 800;      // silence between beeps when far
const int FASTEST_GAP_MS = 60;       // silence between beeps when close

const int QUIET_DUTY = 20;           // volume when far (0-255)
const int LOUD_DUTY  = 128;          // volume when close (128 = 50% = loudest possible)

const unsigned long PING_INTERVAL_MS = 60;    // HC-SR04 needs ~60 ms between pings
const unsigned long ECHO_TIMEOUT_US  = 25000; // ~4 m; no echo after this = nothing there

const unsigned long HOLD_TO_TOGGLE_MS = 2000; // how long to hold the switch to turn on/off
// ---------------------------------------------------------------

const float NO_ECHO = 999.0;

float history[3] = {NO_ECHO, NO_ECHO, NO_ECHO}; // last 3 readings for smoothing
int historyIndex = 0;
float distanceCm = NO_ECHO;

unsigned long lastPingTime = 0;
bool beepOn = false;
unsigned long beepStateStart = 0;

// ----- Power state -----
bool caneActive = false;          // false = sleep mode, true = running
unsigned long pressStart = 0;     // when the current hold began (0 = not pressed)
bool waitForRelease = false;      // after a toggle, ignore the switch until it's let go

// ----- Camera / WiFi state -----
camera_config_t config;
bool cameraOk = false;            // camera started successfully
bool serverStarted = false;       // web server is running
unsigned long lastWifiPrint = 0;

void startCameraServer();         // defined in app_httpd.cpp

// ====================================================================
//  CAMERA
// ====================================================================
bool camera_init() {
  // The camera's clock uses LEDC channel 7 / timer 3 so it can't clash
  // with the speaker, which Arduino puts on channel 0 / timer 0.
  config.ledc_channel = LEDC_CHANNEL_7;
  config.ledc_timer   = LEDC_TIMER_3;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 10000000;
  config.frame_size = FRAMESIZE_QVGA;
  config.pixel_format = PIXFORMAT_RGB565;   // GC0308 camera can't do JPEG
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 10;
  config.fb_count = 1;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed (0x%x). Check ribbon cable and board_config.h\n", err);
    return false;
  }

  sensor_t * s = esp_camera_sensor_get();
  if (s == NULL) {
    Serial.println("Camera sensor not found");
    return false;
  }
  Serial.printf("Camera OK, sensor PID: 0x%x\n", s->id.PID);

  uint16_t pid = s->id.PID;
  if (pid == OV2640_PID) {
    s->set_hmirror(s, 1);
    s->set_vflip(s, 1);
  } else if (pid == OV3660_PID) {
    s->set_hmirror(s, 1);
    s->set_vflip(s, 0);
  } else if (pid == GC2145_PID) {
    s->set_hmirror(s, 0);
    delay(500);
    s->set_vflip(s, 0);
  } else if (pid == GC0308_PID) {
    s->set_hmirror(s, 0);
    delay(500);
    s->set_vflip(s, 0);
  } else {
    s->set_hmirror(s, 1);
    s->set_vflip(s, 0);
  }
  s->set_brightness(s, 1);  // Slightly increase brightness
  s->set_saturation(s, 0);  // Reduce saturation
  s->set_ae_level(s, -3);   // Set exposure compensation level
  return true;
}

// Runs every loop. Starts the stream once WiFi is up. Never blocks the cane.
void checkWiFi() {
  if (!cameraOk || serverStarted) return;

  if (WiFi.status() == WL_CONNECTED && WiFi.STA.hasIP()) {
    startCameraServer();
    serverStarted = true;
    Serial.print("Camera Ready! Use 'http://");
    Serial.print(WiFi.localIP());
    Serial.println("' to connect");
  } else if (millis() - lastWifiPrint >= 3000) {
    lastWifiPrint = millis();
    Serial.print("WiFi connecting... status: ");
    Serial.println(WiFi.status());
  }
}

// ====================================================================
//  CANE: SONAR + SPEAKER
// ====================================================================
// One ping. Returns distance in cm, or NO_ECHO if nothing is in range.
float pingCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
  if (duration == 0) return NO_ECHO;

  float cm = duration * 0.0343 / 2.0;
  if (cm < 2.0 || cm > 400.0) return NO_ECHO;
  return cm;
}

// Middle value of three. Throws out a single bad reading.
float median3(float a, float b, float c) {
  if ((a <= b && b <= c) || (c <= b && b <= a)) return b;
  if ((b <= a && a <= c) || (c <= a && a <= b)) return a;
  return c;
}

// The speaker is shared with the voice, so these go through voice.cpp.
// While the cane is talking, beeper writes are ignored.
void speakerOn(int duty) { speakerWrite(duty); }
void speakerOff()        { speakerWrite(0); }

// Plays one note at a given pitch, then puts the pitch back for the beeper.
void playNote(int hz, int ms) { speakerNote(hz, ms, LOUD_DUTY); }

// Rising chime = ON, falling chime = OFF, so a blind user can tell which happened.
void playPowerOnChime()  { playNote(1200, 120); playNote(1800, 120); playNote(2400, 180); }
void playPowerOffChime() { playNote(2400, 120); playNote(1800, 120); playNote(1200, 180); }

void turnOn() {
  caneActive = true;
  // Start fresh so old readings don't cause a beep right away
  history[0] = history[1] = history[2] = NO_ECHO;
  distanceCm = NO_ECHO;
  beepOn = false;
  beepStateStart = millis();
  playPowerOnChime();
  Serial.println(">>> Cane ON");
}

void turnOff() {
  caneActive = false;
  voiceStop();                    // stop any warning that's still playing
  speakerOff();
  beepOn = false;
  playPowerOffChime();
  Serial.println(">>> Cane OFF (sleep mode)");
}

// Watches the switch. A continuous 2-second hold flips the cane on/off.
void checkPowerSwitch() {
  bool pressed = (digitalRead(SWITCH_PIN) == LOW);
  unsigned long now = millis();

  if (!pressed) {
    pressStart = 0;          // let go: reset the hold timer
    waitForRelease = false;  // ready for the next hold
    return;
  }

  if (waitForRelease) return;   // already toggled on this hold; wait for release

  if (pressStart == 0) {
    pressStart = now;            // hold just started
  } else if (now - pressStart >= HOLD_TO_TOGGLE_MS) {
    waitForRelease = true;       // only toggle once per hold
    if (caneActive) turnOff();
    else            turnOn();
  }
}

// One pass of the sonar + beeper logic.
void runCane() {
  unsigned long now = millis();

  // 1) Read the sonar every PING_INTERVAL_MS
  if (now - lastPingTime >= PING_INTERVAL_MS) {
    lastPingTime = now;
    history[historyIndex] = pingCm();
    historyIndex = (historyIndex + 1) % 3;
    distanceCm = median3(history[0], history[1], history[2]);

    if (distanceCm >= NO_ECHO) {
      Serial.println("Distance: nothing in range");
    } else {
      Serial.print("Distance: ");
      Serial.print(distanceCm, 1);
      Serial.println(" cm");
    }
  }

  // While the cane is talking, the beeper waits (the sonar keeps measuring)
  if (voiceSpeaking()) {
    beepOn = false;
    beepStateStart = millis();
    return;
  }

  // 2) Nothing close enough -> stay silent
  if (distanceCm > ALERT_START_CM) {
    speakerOff();
    beepOn = false;
    return;
  }

  // 3) Very close -> solid loud tone
  if (distanceCm <= DANGER_CM) {
    speakerOn(LOUD_DUTY);
    beepOn = true;
    beepStateStart = millis();
    return;
  }

  // 4) In between -> beep, faster and louder as it gets closer
  // closeness: 0.0 at ALERT_START_CM (far), 1.0 at DANGER_CM (close)
  float closeness = (ALERT_START_CM - distanceCm) / (ALERT_START_CM - DANGER_CM);
  closeness = constrain(closeness, 0.0, 1.0);

  int volume = QUIET_DUTY + closeness * (LOUD_DUTY - QUIET_DUTY);
  int gapMs  = SLOWEST_GAP_MS - closeness * (SLOWEST_GAP_MS - FASTEST_GAP_MS);

  now = millis();
  if (beepOn) {
    if (now - beepStateStart >= BEEP_MS) {
      speakerOff();               // beep finished, start the gap
      beepOn = false;
      beepStateStart = now;
    } else {
      speakerOn(volume);          // keep beeping, update volume live
    }
  } else {
    if (now - beepStateStart >= (unsigned long)gapMs) {
      speakerOn(volume);          // gap finished, start the next beep
      beepOn = true;
      beepStateStart = now;
    }
  }
}

// ====================================================================
//  SETUP + LOOP
// ====================================================================
void setup() {
  Serial.begin(115200);
  delay(2000);                    // give USB serial time to reconnect after reset
  Serial.println();
  Serial.println("=== Smart Cane starting ===");

  // Cane hardware
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(SWITCH_PIN, INPUT_PULLUP);  // reads LOW when the switch is pressed
  digitalWrite(TRIG_PIN, LOW);

  // Camera (on LEDC channel 7 / timer 3)
  cameraOk = camera_init();

  // Speaker: beeper PWM (Arduino gives it channel 0 / timer 0) + voice
  voiceBegin(SPEAKER_PIN, TONE_HZ);

  // WiFi connects in the background; checkWiFi() starts the stream when ready
  if (cameraOk) {
    WiFi.begin(ssid, password);
    WiFi.setSleep(false);
  }

  Serial.println("=== Cane ready. Hold switch 2 s to turn on. ===");
}

void loop() {
  checkPowerSwitch();
  checkWiFi();

  // Sleep mode: no sonar, no sound. Just keep watching the switch.
  if (!caneActive) {
    delay(20);
    return;
  }

  runCane();
}
