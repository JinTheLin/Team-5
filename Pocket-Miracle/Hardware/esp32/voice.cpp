// Smart Cane - voice. See voice.h for how to use it.
#include "voice.h"
#include <ESP_I2S.h>
#include "driver/i2s_pdm.h"
#include <math.h>
#include "src/voice_clips.h"

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
#define VOICE_USE_AMP 0      // 0 = speaker on the beeper pin, 1 = MAX98357A amp

// The PDM output (VOICE_USE_AMP 0) needs a clock pin even though nothing is
// wired to it. GPIO2 is free. Don't connect anything to GPIO2 for now.
#define PDM_CLK_PIN 2

#define AMP_BCLK_PIN 1
#define AMP_LRC_PIN  2
#define AMP_DIN_PIN  41

const int VOICE_VOLUME_PERCENT = 100;  // 0-100
// Loudness boost: makes the quiet parts of speech louder (smooth compressor).
// 1.0 = off. Speech is much weaker than a beep, so the small speaker needs it.
const float VOICE_BOOST = 25.0f;
const int WORD_GAP_MS = 60;            // silence between words
const int MAX_CLIPS = 6;               // longest sentence, in clips

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
static I2SClass i2s;
static int spkPin = -1;
static int spkToneHz = 2000;
static SemaphoreHandle_t speakerMutex = NULL;  // whoever holds it owns the speaker
static TaskHandle_t voiceTask = NULL;
static int16_t ulawTable[256];

// The next sentence to say (written by voiceSay, read by the voice task)
static portMUX_TYPE requestLock = portMUX_INITIALIZER_UNLOCKED;
static const VoiceClip *pendingClips[MAX_CLIPS];
static int pendingCount = 0;
static char pendingText[40];
static volatile bool newRequest = false;
static volatile bool stopRequest = false;
static volatile bool speaking = false;

static const char *NUMBER_CLIPS[] = {"zero", "one", "two", "three", "four", "five"};

// Test tone for /warn?msg=test: 0.6 s of 1 kHz at full volume through the
// voice path. If you hear it, the speaker output works.
static const uint32_t TEST_TONE_SAMPLES = VOICE_SAMPLE_RATE * 6 / 10;
static uint8_t testToneData[TEST_TONE_SAMPLES];
static const VoiceClip testTone = {"test", testToneData, TEST_TONE_SAMPLES};

// ---------------------------------------------------------------------
// Building a sentence out of clips
// ---------------------------------------------------------------------
static const VoiceClip *findClip(const char *name) {
  for (size_t i = 0; i < VOICE_CLIP_COUNT; i++) {
    if (strcmp(VOICE_CLIPS[i].name, name) == 0) return &VOICE_CLIPS[i];
  }
  return NULL;
}

static void addClip(const VoiceClip **out, int &count, const char *name) {
  const VoiceClip *clip = findClip(name);
  if (clip != NULL && count < MAX_CLIPS) out[count++] = clip;
}

// "chair,0.9" -> [chair, less_than_one_meter, caution]. Same rules as
// Alert.sentence in Computer Vision/cane_logic.py. Returns the clip count.
static int buildSentence(const char *message, const VoiceClip **out) {
  // Object word: everything before the comma, trimmed, lowercase
  char word[24];
  const char *comma = strchr(message, ',');
  size_t len = comma ? (size_t)(comma - message) : strlen(message);
  while (len > 0 && isspace((unsigned char)*message)) { message++; len--; }
  while (len > 0 && isspace((unsigned char)message[len - 1])) len--;
  if (len == 0) return 0;
  if (len >= sizeof(word)) len = sizeof(word) - 1;
  for (size_t i = 0; i < len; i++) word[i] = tolower((unsigned char)message[i]);
  word[len] = '\0';

  // Distance in meters (optional)
  float meters = NAN;
  if (comma != NULL) {
    char *end;
    float m = strtof(comma + 1, &end);
    if (end != comma + 1 && isfinite(m) && m >= 0) meters = m;
  }

  int count = 0;
  addClip(out, count, word);  // unknown word: skip it, still say the distance
  if (isnan(meters)) {
    addClip(out, count, "ahead");
    addClip(out, count, "caution");
  } else if (meters < 1.0f) {
    addClip(out, count, "less_than_one_meter");
    addClip(out, count, "caution");
  } else {
    int n = (int)(meters + 0.5f);  // what the user hears: 1.4 -> one, 2.6 -> three
    if (n == 1) {
      addClip(out, count, "one");
      addClip(out, count, "meter");
      addClip(out, count, "caution");
    } else if (n <= 5) {
      addClip(out, count, NUMBER_CLIPS[n]);
      addClip(out, count, "meters");
    } else {
      addClip(out, count, "ahead");
    }
  }
  return count;
}

// ---------------------------------------------------------------------
// Speaker output
// ---------------------------------------------------------------------
static int16_t ulawDecode(uint8_t u) {
  u = ~u;
  int exponent = (u >> 4) & 0x07;
  int mantissa = u & 0x0F;
  int sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return (u & 0x80) ? -sample : sample;
}

// Hand the speaker pin from the beeper (LEDC) to the voice (I2S).
static bool outputStart() {
  ledcWrite(spkPin, 0);  // silence the beeper (a beep could be on right now)
#if VOICE_USE_AMP
  i2s.setPins(AMP_BCLK_PIN, AMP_LRC_PIN, AMP_DIN_PIN);
  return i2s.begin(I2S_MODE_STD, VOICE_SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
#else
  ledcDetach(spkPin);
  i2s.setPinsPdmTx(PDM_CLK_PIN, spkPin);
  if (!i2s.begin(I2S_MODE_PDM_TX, VOICE_SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
    ledcAttach(spkPin, spkToneHz, 8);  // failed: give the pin back to the beeper
    ledcWrite(spkPin, 0);
    return false;
  }
  // The library starts PDM in "codec" mode (made for a PDM chip, half volume).
  // Switch to "DAC" mode, which is made for driving a speaker / filter directly.
  i2s_chan_handle_t tx = i2s.txChan();
  i2s_pdm_tx_clk_config_t clk = I2S_PDM_TX_CLK_DAC_DEFAULT_CONFIG(VOICE_SAMPLE_RATE);
  i2s_pdm_tx_slot_config_t slot = I2S_PDM_TX_SLOT_DAC_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
  bool dacMode = i2s_channel_disable(tx) == ESP_OK &&
                 i2s_channel_reconfig_pdm_tx_clock(tx, &clk) == ESP_OK &&
                 i2s_channel_reconfig_pdm_tx_slot(tx, &slot) == ESP_OK;
  i2s_channel_enable(tx);  // (harmless error if it's already running)
  if (!dacMode) Serial.println("Voice: couldn't switch to DAC mode, using codec mode");
  return true;
#endif
}

// Give the speaker pin back to the beeper.
static void outputStop() {
  i2s.end();
#if !VOICE_USE_AMP
  ledcAttach(spkPin, spkToneHz, 8);
  ledcWrite(spkPin, 0);
#endif
}

static void writeSilence(int ms) {
  static int16_t zeros[128];
  int samples = VOICE_SAMPLE_RATE / 1000 * ms;
  while (samples > 0) {
    int n = samples < 128 ? samples : 128;
    i2s.write((const uint8_t *)zeros, n * sizeof(int16_t));
    samples -= n;
  }
}

// Plays one clip. Returns false if it was cut off by a newer message or voiceStop().
static bool playClip(const VoiceClip *clip) {
  int16_t buf[256];
  uint32_t pos = 0;
  while (pos < clip->length) {
    if (newRequest || stopRequest) return false;
    int n = 0;
    while (n < 256 && pos < clip->length) {
      buf[n++] = ulawTable[clip->data[pos++]];
    }
    i2s.write((const uint8_t *)buf, n * sizeof(int16_t));
  }
  return true;
}

// Moves the pending sentence into `clips`. Returns false if there's none.
static bool takeRequest(const VoiceClip **clips, int &count, char *text, size_t textSize) {
  bool got = false;
  portENTER_CRITICAL(&requestLock);
  if (newRequest) {
    count = pendingCount;
    for (int i = 0; i < count; i++) clips[i] = pendingClips[i];
    strlcpy(text, pendingText, textSize);
    newRequest = false;
    stopRequest = false;
    got = true;
  }
  portEXIT_CRITICAL(&requestLock);
  return got;
}

// Runs on core 0, so it never interrupts the sonar timing in loop() (core 1).
static void voiceTaskMain(void *) {
  const VoiceClip *clips[MAX_CLIPS];
  int count = 0;
  char text[40];

  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);  // sleep until voiceSay()
    if (!takeRequest(clips, count, text, sizeof(text))) continue;

    xSemaphoreTake(speakerMutex, portMAX_DELAY);  // wait for a chime to finish
    speaking = true;
    if (!outputStart()) {
      Serial.println("Voice: could not start audio output");
      speaking = false;
      xSemaphoreGive(speakerMutex);
      continue;
    }

    bool again = true;
    while (again) {
      again = false;
      Serial.printf("Voice: \"%s\"\n", text);
      bool finished = true;
      for (int i = 0; i < count && finished; i++) {
        finished = playClip(clips[i]);
        if (finished && i < count - 1) writeSilence(WORD_GAP_MS);
      }
      // Cut off by a newer message: say that one instead (output stays on)
      if (!finished && !stopRequest) {
        again = takeRequest(clips, count, text, sizeof(text));
      }
    }

    if (!stopRequest) writeSilence(150);  // let the last sound play out before closing
    outputStop();
    speaking = false;
    xSemaphoreGive(speakerMutex);
  }
}

// ---------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------
void voiceBegin(int speakerPin, int toneHz) {
  spkPin = speakerPin;
  spkToneHz = toneHz;

  // Decode table with volume + loudness boost: y = tanh(boost * x) / tanh(boost)
  float volume = constrain(VOICE_VOLUME_PERCENT, 0, 100) / 100.0f;
  float boost = VOICE_BOOST < 1.0f ? 1.0f : VOICE_BOOST;
  for (int i = 0; i < 256; i++) {
    float x = ulawDecode((uint8_t)i) / 32768.0f;
    float y = (boost > 1.0f) ? tanhf(boost * x) / tanhf(boost) : x;
    ulawTable[i] = (int16_t)(y * 32767.0f * volume);
  }

  // Test tone: 1 kHz square wave (mu-law 0x80 = loudest +, 0x00 = loudest -)
  const uint32_t half = VOICE_SAMPLE_RATE / 1000 / 2;
  for (uint32_t i = 0; i < TEST_TONE_SAMPLES; i++) {
    testToneData[i] = ((i / half) % 2 == 0) ? 0x80 : 0x00;
  }

  speakerMutex = xSemaphoreCreateMutex();
  ledcAttach(spkPin, spkToneHz, 8);  // beeper owns the pin until the voice needs it
  ledcWrite(spkPin, 0);

  xTaskCreatePinnedToCore(voiceTaskMain, "voice", 6144, NULL, 6, &voiceTask, 0);
  Serial.printf("Voice ready: %u clips, output = %s\n", (unsigned)VOICE_CLIP_COUNT,
                VOICE_USE_AMP ? "MAX98357A amp" : "speaker pin (PDM)");
}

bool voiceSay(const char *message) {
  if (voiceTask == NULL || message == NULL) return false;
  const VoiceClip *clips[MAX_CLIPS];
  int count;
  if (strcmp(message, "test") == 0) {
    clips[0] = &testTone;  // /warn?msg=test
    count = 1;
  } else {
    count = buildSentence(message, clips);
  }
  if (count == 0) return false;

  portENTER_CRITICAL(&requestLock);
  for (int i = 0; i < count; i++) pendingClips[i] = clips[i];
  pendingCount = count;
  strlcpy(pendingText, message, sizeof(pendingText));
  newRequest = true;
  portEXIT_CRITICAL(&requestLock);

  xTaskNotifyGive(voiceTask);
  return true;
}

void voiceStop() {
  portENTER_CRITICAL(&requestLock);
  newRequest = false;  // drop anything waiting
  stopRequest = true;  // cut off what's playing
  portEXIT_CRITICAL(&requestLock);
  unsigned long start = millis();
  while (speaking && millis() - start < 1000) delay(5);
}

bool voiceSpeaking() {
  return speaking;
}

void speakerWrite(int duty) {
  if (speakerMutex == NULL) return;
  if (xSemaphoreTake(speakerMutex, 0) == pdTRUE) {  // voice busy -> skip
    ledcWrite(spkPin, duty);
    xSemaphoreGive(speakerMutex);
  }
}

void speakerNote(int hz, int ms, int duty) {
  if (speakerMutex == NULL) return;
  xSemaphoreTake(speakerMutex, portMAX_DELAY);
  ledcChangeFrequency(spkPin, hz, 8);
  ledcWrite(spkPin, duty);
  delay(ms);
  ledcWrite(spkPin, 0);
  delay(40);
  ledcChangeFrequency(spkPin, spkToneHz, 8);
  xSemaphoreGive(speakerMutex);
}
