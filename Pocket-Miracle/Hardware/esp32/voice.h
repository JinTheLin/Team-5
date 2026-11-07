/**********************************************************************
  Smart Cane - voice

  Says warnings like "Chair, less than one meter. Caution." by playing
  short word clips back to back. The clips are stored in the ESP32's flash
  (src/voice_clips.cpp, made by voice/make_clips.py).

  The voice and the sonar beeper share one speaker, so all speaker
  access goes through this file:
    speakerWrite()  instead of ledcWrite()
    speakerNote()   instead of ledcChangeFrequency() + delay()

  Output (set VOICE_USE_AMP in voice.cpp):
    0 = the existing speaker on the beeper pin (GPIO47). Works now, quiet.
    1 = MAX98357A amp: BCLK GPIO1, LRC GPIO2, DIN GPIO41. Louder, clearer.
**********************************************************************/
#pragma once
#include <Arduino.h>

// Call once in setup(), instead of ledcAttach() for the speaker.
void voiceBegin(int speakerPin, int toneHz);

// Say a warning. Safe to call from any task (e.g. the web server).
//   "chair,0.9"  -> "Chair, less than one meter. Caution."
//   "door,1.4"   -> "Door, one meter. Caution."
//   "stairs,2.6" -> "Stairs, three meters."
//   "stairs"     -> "Stairs ahead. Caution."
// A new message cuts off one that's still playing.
// Returns false if there's nothing to say (empty message).
bool voiceSay(const char *message);

// Say one recorded phrase by its clip name, e.g. "speaker_muted".
// Returns false if that clip isn't in src/voice_clips.cpp (re-run make_clips.py).
bool voiceSayClip(const char *clipName);

// Stop talking and wait (up to 1 s) until the speaker is free again.
void voiceStop();

// True while the voice is using the speaker.
bool voiceSpeaking();

// Beeper: set the volume (PWM duty 0-255, 0 = silent). Ignored while talking.
void speakerWrite(int duty);

// Beeper: play one note (used by the on/off chimes). Waits for the voice to finish.
void speakerNote(int hz, int ms, int duty);
