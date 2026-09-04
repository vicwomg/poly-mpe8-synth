# POLY-MPE 8 - MPE Web MIDI Synthesizer

A browser-based, 8-voice polyphonic synthesizer built with the Web Audio API and Web MIDI API, featuring full support for **MIDI Polyphonic Expression (MPE)**.

---

## Features

- **8-Voice / 4-Voice Polyphony** with intelligent voice allocation and natural envelope release tails.
- **Simultaneous Dual Oscillators**:
  - Waveforms: Sawtooth, Square, Triangle, Sine per oscillator.
  - Controls: Octave (-2 to +2), Semitones (-12 to +12), Fine detune (cents), and Osc 2 level mix.
- **Resonant Low-Pass Filter**:
  - 4-pole style low-pass filtering.
  - **CC73 Modulation**: Real-time filter cutoff sweeping (per-note in MPE, or global).
  - **Mod Wheel (CC1) Modulation**: Real-time resonance (Q) adjustment.
  - Filter ADSR envelope with bipolar Envelope Amount (-100% to +100%) and Key Tracking.
  - Real-time animated Frequency Response curve with resonant peak indicator.
- **Amplifier & Dynamic Envelopes**:
  - **CC11 Modulation**: Real-time expression volume control.
  - Full Amp ADSR envelope & Master Limiter to ensure zero digital clipping.
- **LFO (Low Frequency Oscillator)**:
  - Waveforms: Sine, Triangle, Square, Sawtooth.
  - Routable to Filter Cutoff (wah) or Pitch (vibrato) with dedicated Rate and Depth controls.
- **Integrated Effects Rack**:
  - **Overdrive / Distortion**: WaveShaper saturation with Drive, Tone, and Mix controls.
  - **Stereo Cross-Delay**: Independent Left/Right delay lines with Time, Feedback, and Mix.
  - **Reverb**: Convolution-modeled ambient reverberation with Decay Time, Damping, and Mix.
- **MPE & Performance Controls**:
  - Full per-note MIDI Polyphonic Expression (MPE) pitch bend with selectable bend range (±2, ±12, ±24, ±48, ±96 semitones).
  - **Inline 2D MPE Touchpad**: XY expressive pad controlling pitch bend and CC73 Cutoff alongside the keyboard.
  - **Interactive 2-Octave Keyboard**: Playable via mouse, touch, or computer keyboard with visible key mappings (`A W S E D F T G Y...`).
  - **Live MIDI Monitor & Settings Modal**: Port selector, live MIDI logger, hardware buffer latency tuner, and polyphony selector.
  - **Audio Engine Power**: Zero-allocation Web Audio graph with ultra-low latency.
- **User & Factory Preset Management**:
  - **15 Factory Presets**: *Clean Pedal Steel Guitar*, *MPE Dream Pad*, *Ambient Shoegaze Shimmer*, *Vaporwave Electric Piano*, *Retro Funk Clavinet*, *Cinematic Bowed Strings*, *Acid Bass Line*, *Expressive Solo Lead*, *80s Poly Brass*, *Cosmic Pluck*, *Vocal Formant Choir*, *8-Bit Arcade Hero*, *Cat's Meow*, *Spacey Cosmic Organ*, and *Init Dual Saw*.
  - **Dynamic Modification Asterisk (`*`)**: An asterisk `*` automatically appears next to the patch name whenever parameters are tweaked from their original settings, and disappears upon saving.
  - **Auto-Persistence Across Sessions**: The current active patch and any in-progress tweaks are preserved and seamlessly restored on refresh or mobile app relaunch.
  - **Custom User Presets**: Save, edit/overwrite, and delete custom patches with dedicated Save (floppy disk) and Delete (trash can) buttons.
  - **Cross-Platform Storage**: Capacitor-ready storage architecture compatible with Web, Android WebView, and iOS WKWebView.
- **Native iOS & Android Apps (Capacitor)**:
  - **Native CoreMIDI on iOS**: Overcomes Apple's lack of Web MIDI in WKWebView with a custom Swift `CoreMIDI` bridge that auto-detects USB & Bluetooth LE MIDI controllers.
  - **Zero-Click Instant Audio Startup**: Audio initializes immediately on native app launch without requiring a manual tap.
  - **Native Screen Keep-Awake**: Uses native OS window flags (`isIdleTimerDisabled` and `FLAG_KEEP_SCREEN_ON`) while cleanly hiding web wake-lock settings.

---

## Native Mobile Apps (iOS & Android)

The synthesizer is packaged for iOS (iPhone & iPad) and Android using **Capacitor**.

### Build & Sync Native Projects
Whenever you make changes to web assets (`index.html`, `js/`, `css/`, `assets/`):
```bash
npm run cap:sync
```

### Launch in Xcode (iOS)
```bash
npm run cap:ios
```
- Select your target device or simulator in Xcode and press **Run (Cmd + R)**.
- Full hardware and Bluetooth LE MIDI controllers are supported natively via Apple's `CoreMIDI` framework.

### Launch in Android Studio (Android)
```bash
npm run cap:android
```
- Connect your Android device (or launch an emulator) and press **Run**.

---

## Quick Start

### 1. Run Local Server
From the project directory, run:
```bash
python3 server.py 8080
```
Or if you prefer Node:
```bash
npm start
```

### 2. Open in Browser
Open your browser (Chrome, Edge, or Opera recommended for full Web MIDI support) and navigate to:
```
http://localhost:8080
```

### 3. Start Audio
Click the **START AUDIO** button in the top bar to enable the browser's Web Audio context.

### 4. Connect MIDI / Play
- If you have an MPE controller (e.g. Roli Seaboard, LinnStrument, Keith McMillen, Roger Linn, Sensel Morph) or standard MIDI keyboard, select it in the **MIDI IN** dropdown.
- Alternatively, play with the on-screen keyboard, your computer keyboard, or the 2D MPE Touchpad.
