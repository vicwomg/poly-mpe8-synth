import { SynthVoice } from "./synth-voice.js";

/**
 * SynthEngine: Orchestrates the 8-voice polyphonic synthesizer,
 * master audio effects graph, MPE routing, and preset management.
 */
export class SynthEngine {
  constructor() {
    this.ctx = null;
    const isAndroid =
      typeof navigator !== "undefined" &&
      /Android/i.test(navigator.userAgent || "");
    const savedBuffer =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("synth_buffer_mode")
        : null;
    // On Android, default to 'interactive' (10ms buffer) for crisp response
    if (isAndroid) {
      if (
        !savedBuffer ||
        savedBuffer === "ultralow" ||
        savedBuffer === "balanced"
      ) {
        this.bufferMode = "interactive";
        try {
          localStorage.setItem("synth_buffer_mode", "interactive");
        } catch (_) {}
      } else {
        this.bufferMode = savedBuffer;
      }
    } else {
      this.bufferMode = savedBuffer || "ultralow";
    }

    this.voiceCount = parseInt(
      (typeof localStorage !== "undefined" &&
        localStorage.getItem("synth_voice_count")) ||
        "8",
      10,
    );
    this.voices = [];
    this.hasSmoothCutoff = false; // Set to true by UI when ballistic animation handles cutoff
    this.ui = null;
    this.onVoiceStateChange = null; // Callback for UI voice meters
    this.onBufferStatChange = null; // Callback for UI buffer stats

    // Global / Active synth parameters
    this.params = {
      // Oscillators
      osc1Waveform: "sawtooth",
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: 0,

      osc2Waveform: "sawtooth",
      osc2Octave: 0,
      osc2Semi: 0,
      osc2Fine: 7, // slight detune default
      osc2Mix: 0.5,

      // Filter
      filterCutoff: 2500, // Hz
      filterResonance: 2.0, // Q
      filterEnvAmount: 0.5, // -1.0 to 1.0
      filterKeyTracking: 0.4, // 0.0 to 1.0
      filterAttack: 0.04,
      filterDecay: 0.35,
      filterSustain: 0.3,
      filterRelease: 0.4,

      // Amplifier
      ampAttack: 0.02,
      ampDecay: 0.25,
      ampSustain: 0.7,
      ampRelease: 0.35,

      // LFO
      lfoWaveform: "sine",
      lfoRate: 3.5, // Hz
      lfoDepth: 0.0, // 0 to 1
      lfoTarget: "filter", // 'filter', 'pitch', 'amp', 'none'

      // Pluck / Pick Transient
      pickTransient: 0.0, // Pluck Level (0.0 to 1.0)

      // Distortion & Amp Effect
      distortionEnabled: false,
      distortionDrive: 20, // 1 to 80
      distortionTone: 4000, // 500 Hz to 12000 Hz
      cabSimEnabled: false, // Guitar Speaker Cabinet Emulation
      cabSimType: "1x12", // '1x12', '2x12', '4x12', '1x15'

      // Delay Effect
      delayEnabled: true,
      delayTime: 0.28, // seconds
      delayFeedback: 0.4,
      delayMix: 0.25,

      // Reverb Effect
      reverbEnabled: false,
      reverbTime: 2.2, // seconds
      reverbDamp: 3500, // 500 Hz to 10000 Hz
      reverbMix: 0.3,

      // Master
      masterVolume: 0.75,
      mpePitchBendRange: 48, // Default 48 semitones for MPE
      mpeMasterChannel: 1,
      cc1Target: "resonance", // 'resonance' (Filter Q) or 'lforate' (LFO Rate)
      volumeCC: 11, // 11 (Expression - Default) or 7 (Channel Volume)
      mpePressureTarget: "both", // 'both' (Dynamics & Filter), 'dynamics', 'filter', 'off'
      mpeTimbreTarget: "cutoff", // 'cutoff' (Default), 'resonance', 'osc2mix', 'lforate', 'lfodepth', 'off'

      // Voice Engine Mode: 'analog' (Subtractive Dual Osc) or 'guitar' (Extended Karplus-Strong Physical Model)
      voiceMode: "analog",

      // Physical Modeling Guitar Parameters
      guitarDecay: 0.975, // String Sustain / Feedback (0.90 to 0.9998 -> 0.35s to 15.0s)
      guitarDamping: 0.7, // String Brightness / High-frequency dissipation (0.05 to 0.95)
      guitarPluckPos: 0.18, // Pluck position along string (0.05 = near bridge, 0.5 = 12th fret)
      guitarPickupPos: 0.12, // Magnetic pickup position (0.08 = bridge, 0.35 = neck)
      guitarPickBite: 0.7, // Pick snap / transient brightness (0.0 to 1.0)
      guitarStiffness: 0.08, // String stiffness inharmonicity / dispersion (0.0 to 0.70)
    };

    // AudioWorklet state
    this.isWorkletLoaded = false;

    // Controller states
    this.globalCC73 = 64;
    this.globalCC74 = 64;
    this.globalCC1 = 0;
    this.globalCC11 = 127;
    this.globalCC7 = 127;
    this.silentAudioElement = null;
    this._recoveryPromise = null;
    this._lastNotePerf = 0;
    this._lastNoteAudioTime = 0;
  }

  /**
   * Configures iOS AudioSession and media playback mode to bypass the hardware silent switch.
   */
  configureIosAudioSession() {
    // 1. Modern iOS WebKit standard (iOS 17+)
    if (typeof navigator !== "undefined" && navigator.audioSession) {
      try {
        navigator.audioSession.type = "playback";
      } catch (err) {
        console.warn("Failed to set navigator.audioSession.type:", err);
      }
    }

    // 2. Trigger native iOS CoreMidiPlugin audio session configuration
    if (
      typeof window !== "undefined" &&
      window.Capacitor?.Plugins?.CoreMidiPlugin?.configureAudioSession
    ) {
      window.Capacitor.Plugins.CoreMidiPlugin.configureAudioSession().catch(
        () => {},
      );
    }

    // 3. Universal WebKit silent audio loop (forces iOS WebAudio into media playback category)
    if (!this.silentAudioElement && typeof document !== "undefined") {
      try {
        const audio = document.createElement("audio");
        audio.setAttribute("x-webkit-airplay", "deny");
        audio.setAttribute("playsinline", "true");
        audio.loop = true;
        audio.volume = 0.001;
        audio.src =
          "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
        const playPromise = audio.play();
        if (playPromise) playPromise.catch(() => {});
        this.silentAudioElement = audio;
      } catch (e) {
        console.warn("Could not start silent audio element:", e);
      }
    } else if (this.silentAudioElement && this.silentAudioElement.paused) {
      this.silentAudioElement.play().catch(() => {});
    }
  }

  /**
   * Initializes the Web Audio context and audio graph.
   */
  async initAudio() {
    this.configureIosAudioSession();

    if (this.isAudioStarted && this.ctx) {
      if (this.ctx.state === "suspended") {
        await this.ctx.resume();
      }
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    // Configurable buffer latency:
    // 'interactive' (10ms): low latency default
    // 'balanced' (25ms): medium latency buffer
    // 'ultralow' (0): raw hardware minimum (<5ms)
    // 'safe' (50ms): maximum safety buffer for heavy load
    let latencyOption = 0.025;
    if (this.bufferMode === "ultralow") {
      latencyOption = 0;
    } else if (this.bufferMode === "interactive") {
      latencyOption = "interactive";
    } else if (this.bufferMode === "balanced") {
      latencyOption = 0.025;
    } else if (this.bufferMode === "safe") {
      latencyOption = 0.05;
    }

    this.ctx = new AudioContextClass({ latencyHint: latencyOption });
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }

    this.masterHeadroomGain = 0.82; // -1.7 dBFS headroom prevents digital clipping at max volume

    // 1. Voices Summing Bus (0.75 scaling prevents multi-voice clipping)
    this.voicesBus = this.ctx.createGain();
    this.voicesBus.gain.setValueAtTime(0.75, this.ctx.currentTime);

    // Pre-render acoustic plectrum snap buffer for pick transients
    this.pickImpulseBuffer = this.createPickImpulseBuffer();

    // Load Extended Karplus-Strong AudioWorklet Processor for physical modeling guitar
    await this.loadKarplusStrongWorklet();

    // 2. Effects Processing Chain (Distortion -> Cab Sim -> Stereo Delay -> Reverb)
    this.setupDistortionEffect();
    this.setupCabSimEffect();
    this.setupDelayEffect();
    this.setupReverbEffect();

    // 3. Master Limiter / Fast Compressor
    this.masterLimiter = this.ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.setValueAtTime(-2.5, this.ctx.currentTime);
    this.masterLimiter.knee.setValueAtTime(6.0, this.ctx.currentTime);
    this.masterLimiter.ratio.setValueAtTime(16.0, this.ctx.currentTime);
    this.masterLimiter.attack.setValueAtTime(0.001, this.ctx.currentTime);
    this.masterLimiter.release.setValueAtTime(0.04, this.ctx.currentTime);

    // 4. Master Volume Gain (scaled with safe headroom)
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(
      this.params.masterVolume * this.masterHeadroomGain,
      this.ctx.currentTime,
    );

    // 5. Soft-Clipper Stage (musical saturation safety ceiling before DAC)
    this.masterClipper = this.ctx.createWaveShaper();
    this.masterClipper.curve = this.createSoftClipCurve(512);
    this.masterClipper.oversample = "2x";

    // 6. Analyser Node for Visualizer
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    // Connect audio signal chain:
    // voicesBus -> distortion -> cabSim -> stereo delay -> reverb -> limiter -> masterGain -> masterClipper -> destination
    this.connectAudioGraph();

    // 7. Pre-allocate Polyphonic Voice Pool (16 voices for click-free voice stealing)
    const poolSize = Math.max(16, this.voiceCount * 2);
    if (this.voices && this.voices.length > 0) {
      for (const v of this.voices) {
        if (typeof v.dispose === "function") v.dispose();
      }
      this.voices = [];
    }
    this.voices = [];
    for (let i = 0; i < poolSize; i++) {
      this.voices.push(new SynthVoice(this.ctx, this.voicesBus, i, this));
    }

    // 8. LFO Engine Setup
    this.setupLFO();

    this.isAudioStarted = true;

    // Report measured hardware buffer latency
    if (this.onBufferStatChange) {
      const ms = this.ctx.baseLatency
        ? (this.ctx.baseLatency * 1000).toFixed(1)
        : (latencyOption * 1000).toFixed(0);
      this.onBufferStatChange(ms);
    }
  }

  /**
   * Reconfigures audio buffer mode or polyphony voice count dynamically.
   */
  async reconfigureAudio(bufferMode = null, voiceCount = null) {
    if (bufferMode) {
      this.bufferMode = bufferMode;
      localStorage.setItem("synth_buffer_mode", bufferMode);
    }
    if (voiceCount) {
      this.voiceCount = parseInt(voiceCount, 10);
      localStorage.setItem("synth_voice_count", this.voiceCount.toString());
    }

    if (this.isAudioStarted && this.ctx) {
      await this.recoverAudioEngine(true);
    }
  }

  /**
   * Recovers audio engine after device sleep, lock, interruption, or stream death.
   * Tests context health (state, clock advancement, latency) and cleanly recreates
   * the AudioContext if frozen or degraded to maintain pristine low-latency AAudio.
   */
  async recoverAudioEngine(forceReinit = false) {
    if (!this.isAudioStarted && !forceReinit) return;

    if (this._recoveryPromise) {
      return this._recoveryPromise;
    }

    this._recoveryPromise = (async () => {
      try {
        await this._doRecoverAudioEngine(forceReinit);
      } finally {
        this._recoveryPromise = null;
      }
    })();

    return this._recoveryPromise;
  }

  async _doRecoverAudioEngine(forceReinit = false) {
    // 1. Panic stop any hanging notes or ringing delay/reverb
    this.panic();

    let needsReinit = forceReinit;

    if (!this.ctx) {
      needsReinit = true;
    } else if (!needsReinit) {
      // Try simple resume if suspended or interrupted
      if (this.ctx.state === "suspended" || this.ctx.state === "interrupted") {
        try {
          await this.ctx.resume();
        } catch (e) {
          console.warn("[SynthEngine] ctx.resume() rejected:", e);
          needsReinit = true;
        }
      }

      // Health check: test if currentTime actually advances
      if (!needsReinit) {
        const t0 = this.ctx.currentTime;
        await new Promise((r) => setTimeout(r, 60));
        const t1 = this.ctx.currentTime;
        const isFrozen = (t1 <= t0);

        // Latency degradation check: if AAudio degraded into legacy AudioTrack fallback (>40ms baseLatency)
        // and user is not in 'safe' buffer mode, force a clean reinit to restore ultra-low latency.
        const isDegradedLatency = (
          this.ctx.baseLatency &&
          this.ctx.baseLatency > 0.040 &&
          this.bufferMode !== "safe"
        );

        if (isFrozen || isDegradedLatency || this.ctx.state !== "running") {
          console.warn(
            `[SynthEngine] Audio health check failed (frozen: ${isFrozen}, degraded: ${isDegradedLatency}, state: ${this.ctx.state}, latency: ${this.ctx.baseLatency}s). Reinitializing...`
          );
          needsReinit = true;
        }
      }
    }

    if (needsReinit) {
      console.warn("[SynthEngine] Rebuilding fresh low-latency AudioContext after sleep/wake...");
      const oldCtx = this.ctx;
      this.ctx = null;
      this.isAudioStarted = false;

      if (this.voices && this.voices.length > 0) {
        for (const v of this.voices) {
          if (typeof v.dispose === "function") v.dispose();
        }
        this.voices = [];
      }

      try {
        if (oldCtx && oldCtx.state !== "closed") {
          await oldCtx.close();
        }
      } catch (_) {}

      await this.initAudio();

      // Update visualizer references if attached
      if (this.ui && this.ui.visualizer) {
        this.ui.visualizer.synth = this;
        this.ui.visualizer.mockFilter = null;
      }
    }
  }

  // --- Effects Implementation (Distortion, Delay, Reverb) ---

  setupDistortionEffect() {
    this.distIn = this.ctx.createGain();
    this.distDry = this.ctx.createGain();
    this.distWet = this.ctx.createGain();
    this.distOut = this.ctx.createGain();

    this.distWaveShaper = this.ctx.createWaveShaper();
    this.distWaveShaper.curve = this.makeDistortionCurve(
      this.params.distortionDrive,
    );
    this.distWaveShaper.oversample = "2x";

    this.distFilter = this.ctx.createBiquadFilter();
    this.distFilter.type = "lowpass";
    this.distFilter.frequency.setValueAtTime(
      this.params.distortionTone,
      this.ctx.currentTime,
    );

    // Wet chain: distIn -> distWaveShaper -> distFilter -> distWet
    this.distIn.connect(this.distWaveShaper);
    this.distWaveShaper.connect(this.distFilter);
    this.distFilter.connect(this.distWet);

    this.updateDistortionMix();

    this.distDry.connect(this.distOut);
    this.distWet.connect(this.distOut);
  }

  async loadKarplusStrongWorklet() {
    if (!this.ctx || !this.ctx.audioWorklet) {
      console.warn(
        "Web Audio AudioWorklet is not supported in this browser/environment",
      );
      this.isWorkletLoaded = false;
      return false;
    }
    try {
      await this.ctx.audioWorklet.addModule("js/karplus-strong-processor.js");
      this.isWorkletLoaded = true;
      return true;
    } catch (err) {
      console.warn(
        "Direct AudioWorklet addModule failed, trying Blob fallback:",
        err,
      );
      try {
        const response = await fetch("js/karplus-strong-processor.js");
        const text = await response.text();
        const blob = new Blob([text], { type: "application/javascript" });
        const blobUrl = URL.createObjectURL(blob);
        await this.ctx.audioWorklet.addModule(blobUrl);
        URL.revokeObjectURL(blobUrl);
        this.isWorkletLoaded = true;
        return true;
      } catch (fallbackErr) {
        console.error("All AudioWorklet loading methods failed:", fallbackErr);
        this.isWorkletLoaded = false;
        return false;
      }
    }
  }

  createPickImpulseBuffer() {
    if (!this.ctx) return null;
    const rate = this.ctx.sampleRate;
    const duration = 0.032; // 32ms rich acoustic plectrum snap
    const length = Math.floor(rate * duration);
    const buffer = this.ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);

    // Filtered acoustic plectrum snap: high-frequency friction burst + mechanical string release thump
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const decayFast = Math.exp(-t * 12.0); // 10ms snap decay
      const decayBody = Math.exp(-t * 6.0); // 20ms string thump decay
      // 1. High-frequency plectrum snap, wire scrape (3.5 kHz & 5 kHz) + broadband attack bite
      const snapNoise = (Math.random() * 2 - 1) * 1.1;
      const scrapeTone1 = Math.sin(2 * Math.PI * 3600 * (i / rate)) * 0.6;
      const scrapeTone2 = Math.sin(2 * Math.PI * 5200 * (i / rate)) * 0.4;
      // 2. Mechanical string release thump (190 Hz deep attack transient)
      const stringThump = Math.sin(2 * Math.PI * 190 * (i / rate)) * 0.9;
      data[i] =
        (snapNoise + scrapeTone1 + scrapeTone2) * decayFast +
        stringThump * decayBody;
    }
    return buffer;
  }

  makeDistortionCurve(amount = 20) {
    const k = Math.max(0, amount);
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      let x = (i * 2) / n_samples - 1;
      if (k === 0) {
        curve[i] = x;
      } else {
        // Asymmetric bias: introduces rich 2nd/4th order even tube harmonics
        const asym = x > 0 ? x * (1.0 + 0.2 * x) : x;
        const shaped =
          ((3 + k) * asym * 20 * deg) / (Math.PI + k * Math.abs(asym));
        curve[i] = Math.tanh(shaped * 1.15);
      }
    }
    return curve;
  }

  // --------------------------------------------------------------------------
  // Guitar Speaker Cabinet Simulation Presets & Filter Curves
  // --------------------------------------------------------------------------
  static CAB_PROFILES = {
    "1x12": {
      name: "1x12 Deluxe",
      description:
        "American open-back combo with sparkling chime, scooped mids, and airy top",
      hpFreq: 95,
      hpQ: 0.707,
      thumpFreq: 140,
      thumpGain: 1.5,
      thumpQ: 1.0,
      scoopFreq: 500,
      scoopGain: -9.0,
      scoopQ: 1.1,
      presenceFreq: 3800,
      presenceGain: 6.5,
      presenceQ: 1.8,
      lp1Freq: 6800,
      lp1Q: 1.1,
      lp2Freq: 8200,
      lp2Q: 0.8,
      levelTrim: 1.2,
    },
    "2x12": {
      name: "2x12 AC",
      description:
        "British Class-A open-back with vocal mid-forward bark and biting Alnico chime",
      hpFreq: 95,
      hpQ: 0.85,
      thumpFreq: 160,
      thumpGain: 2.0,
      thumpQ: 1.4,
      scoopFreq: 1100, // Mid-forward vocal boost
      scoopGain: 5.0,
      scoopQ: 1.2,
      presenceFreq: 2650,
      presenceGain: 9.5,
      presenceQ: 2.8,
      lp1Freq: 4600,
      lp1Q: 1.3,
      lp2Freq: 5600,
      lp2Q: 0.9,
      levelTrim: 0.82,
    },
    "4x12": {
      name: "4x12 British Stack",
      description:
        "Closed-back 4x12 stack with massive gut-punch thump, scooped body, and dark heavy crunch",
      hpFreq: 62,
      hpQ: 0.9,
      thumpFreq: 105,
      thumpGain: 7.5,
      thumpQ: 1.8,
      scoopFreq: 680,
      scoopGain: -8.0,
      scoopQ: 1.4,
      presenceFreq: 2900,
      presenceGain: 8.5,
      presenceQ: 2.4,
      lp1Freq: 3800,
      lp1Q: 1.4,
      lp2Freq: 4700,
      lp2Q: 0.95,
      levelTrim: 0.88,
    },
    "1x15": {
      name: "1x15 Steel Combo",
      description:
        "Vintage 15-inch pedal steel combo with deep sub-bass body, velvety warmth, and sweet mellow highs",
      hpFreq: 40,
      hpQ: 0.707,
      thumpFreq: 75,
      thumpGain: 6.5,
      thumpQ: 1.3,
      scoopFreq: 400,
      scoopGain: -2.5,
      scoopQ: 0.8,
      presenceFreq: 1850,
      presenceGain: 4.5,
      presenceQ: 1.4,
      lp1Freq: 3100,
      lp1Q: 1.0,
      lp2Freq: 4000,
      lp2Q: 0.75,
      levelTrim: 1.12,
    },
  };

  setupCabSimEffect() {
    this.cabIn = this.ctx.createGain();
    this.cabDry = this.ctx.createGain();
    this.cabWet = this.ctx.createGain();
    this.cabOut = this.ctx.createGain();

    // Guitar Speaker Cabinet Filter Chain:
    // 1. Sub-bass rumble highpass
    this.cabHp = this.ctx.createBiquadFilter();
    this.cabHp.type = "highpass";

    // 2. Cabinet Wood Resonance / Low-End Thump
    this.cabThump = this.ctx.createBiquadFilter();
    this.cabThump.type = "peaking";

    // 3. Tone Stack Mid-Scoop / Body Contour
    this.cabScoop = this.ctx.createBiquadFilter();
    this.cabScoop.type = "peaking";

    // 4. Speaker Cone Breakup & Presence Bite
    this.cabPresence = this.ctx.createBiquadFilter();
    this.cabPresence.type = "peaking";

    // 5. Steep 4-Pole Lowpass Rolloff (Two cascaded 2nd-order stages)
    this.cabLp1 = this.ctx.createBiquadFilter();
    this.cabLp1.type = "lowpass";

    this.cabLp2 = this.ctx.createBiquadFilter();
    this.cabLp2.type = "lowpass";

    // Wet chain: cabIn -> cabHp -> cabThump -> cabScoop -> cabPresence -> cabLp1 -> cabLp2 -> cabWet
    this.cabIn.connect(this.cabHp);
    this.cabHp.connect(this.cabThump);
    this.cabThump.connect(this.cabScoop);
    this.cabScoop.connect(this.cabPresence);
    this.cabPresence.connect(this.cabLp1);
    this.cabLp1.connect(this.cabLp2);
    this.cabLp2.connect(this.cabWet);

    this.cabDry.connect(this.cabOut);
    this.cabWet.connect(this.cabOut);

    this.updateCabSimProfile(this.params.cabSimType || "1x12", 0);
    this.updateCabSimMix();
  }

  updateCabSimProfile(type, transitionTime = 0.03) {
    const profile =
      SynthEngine.CAB_PROFILES[type] || SynthEngine.CAB_PROFILES["1x12"];
    if (!this.ctx || !this.cabHp) return;
    const now = this.ctx.currentTime;
    if (transitionTime === 0) {
      this.cabHp.frequency.setValueAtTime(profile.hpFreq, now);
      this.cabHp.Q.setValueAtTime(profile.hpQ, now);
      this.cabThump.frequency.setValueAtTime(profile.thumpFreq, now);
      this.cabThump.gain.setValueAtTime(profile.thumpGain, now);
      this.cabThump.Q.setValueAtTime(profile.thumpQ, now);
      this.cabScoop.frequency.setValueAtTime(profile.scoopFreq, now);
      this.cabScoop.gain.setValueAtTime(profile.scoopGain, now);
      this.cabScoop.Q.setValueAtTime(profile.scoopQ, now);
      this.cabPresence.frequency.setValueAtTime(profile.presenceFreq, now);
      this.cabPresence.gain.setValueAtTime(profile.presenceGain, now);
      this.cabPresence.Q.setValueAtTime(profile.presenceQ, now);
      this.cabLp1.frequency.setValueAtTime(profile.lp1Freq, now);
      this.cabLp1.Q.setValueAtTime(profile.lp1Q, now);
      this.cabLp2.frequency.setValueAtTime(profile.lp2Freq, now);
      this.cabLp2.Q.setValueAtTime(profile.lp2Q, now);
    } else {
      this.cabHp.frequency.setTargetAtTime(profile.hpFreq, now, transitionTime);
      this.cabHp.Q.setTargetAtTime(profile.hpQ, now, transitionTime);
      this.cabThump.frequency.setTargetAtTime(
        profile.thumpFreq,
        now,
        transitionTime,
      );
      this.cabThump.gain.setTargetAtTime(
        profile.thumpGain,
        now,
        transitionTime,
      );
      this.cabThump.Q.setTargetAtTime(profile.thumpQ, now, transitionTime);
      this.cabScoop.frequency.setTargetAtTime(
        profile.scoopFreq,
        now,
        transitionTime,
      );
      this.cabScoop.gain.setTargetAtTime(
        profile.scoopGain,
        now,
        transitionTime,
      );
      this.cabScoop.Q.setTargetAtTime(profile.scoopQ, now, transitionTime);
      this.cabPresence.frequency.setTargetAtTime(
        profile.presenceFreq,
        now,
        transitionTime,
      );
      this.cabPresence.gain.setTargetAtTime(
        profile.presenceGain,
        now,
        transitionTime,
      );
      this.cabPresence.Q.setTargetAtTime(
        profile.presenceQ,
        now,
        transitionTime,
      );
      this.cabLp1.frequency.setTargetAtTime(
        profile.lp1Freq,
        now,
        transitionTime,
      );
      this.cabLp1.Q.setTargetAtTime(profile.lp1Q, now, transitionTime);
      this.cabLp2.frequency.setTargetAtTime(
        profile.lp2Freq,
        now,
        transitionTime,
      );
      this.cabLp2.Q.setTargetAtTime(profile.lp2Q, now, transitionTime);
    }
  }

  updateCabSimMix() {
    if (!this.ctx || !this.cabDry || !this.cabIn || !this.cabWet) return;
    const now = this.ctx.currentTime;
    if (this.params.cabSimEnabled) {
      const profile =
        SynthEngine.CAB_PROFILES[this.params.cabSimType] ||
        SynthEngine.CAB_PROFILES["1x12"];
      const wetGain = profile.levelTrim !== undefined ? profile.levelTrim : 1.0;
      this.cabIn.gain.setTargetAtTime(1.0, now, 0.02);
      this.cabDry.gain.setTargetAtTime(0.0, now, 0.02);
      this.cabWet.gain.setTargetAtTime(wetGain, now, 0.02);
    } else {
      this.cabIn.gain.setTargetAtTime(0.0, now, 0.02);
      this.cabDry.gain.setTargetAtTime(1.0, now, 0.02);
      this.cabWet.gain.setTargetAtTime(0.0, now, 0.02);
    }
  }

  updateDistortionMix() {
    if (!this.ctx || !this.distDry || !this.distIn) return;
    const now = this.ctx.currentTime;
    if (this.params.distortionEnabled) {
      const mix = this.params.distortionMix;
      this.distIn.gain.setTargetAtTime(1.0, now, 0.02);
      this.distDry.gain.setTargetAtTime(1.0 - mix * 0.5, now, 0.02);
      this.distWet.gain.setTargetAtTime(mix, now, 0.02);
    } else {
      this.distIn.gain.setTargetAtTime(0.0, now, 0.02);
      this.distDry.gain.setTargetAtTime(1.0, now, 0.02);
      this.distWet.gain.setTargetAtTime(0.0, now, 0.02);
    }
  }

  setupDelayEffect() {
    this.delayIn = this.ctx.createGain();
    this.delayDry = this.ctx.createGain();
    this.delayWet = this.ctx.createGain();
    this.delayOut = this.ctx.createGain();

    // Left delay
    this.delayNodeL = this.ctx.createDelay(2.0);
    this.delayNodeL.delayTime.setValueAtTime(
      this.params.delayTime,
      this.ctx.currentTime,
    );

    // Right delay (offset slightly for stereo field)
    this.delayNodeR = this.ctx.createDelay(2.0);
    this.delayNodeR.delayTime.setValueAtTime(
      this.params.delayTime * 1.33,
      this.ctx.currentTime,
    );

    // Feedback gains
    this.delayFeedbackGainL = this.ctx.createGain();
    this.delayFeedbackGainR = this.ctx.createGain();
    this.delayFeedbackGainL.gain.setValueAtTime(
      this.params.delayFeedback,
      this.ctx.currentTime,
    );
    this.delayFeedbackGainR.gain.setValueAtTime(
      this.params.delayFeedback,
      this.ctx.currentTime,
    );

    // Channel merger/splitter for true stereo delay
    this.delaySplitter = this.ctx.createChannelSplitter(2);
    this.delayMerger = this.ctx.createChannelMerger(2);

    // Delay internal wiring
    this.delayIn.connect(this.delaySplitter);

    // Left line
    this.delaySplitter.connect(this.delayNodeL, 0);
    this.delayNodeL.connect(this.delayFeedbackGainL);
    this.delayFeedbackGainL.connect(this.delayNodeL);
    this.delayNodeL.connect(this.delayMerger, 0, 0);

    // Right line
    this.delaySplitter.connect(
      this.delayNodeR,
      1 % this.delaySplitter.numberOfOutputs,
    );
    this.delayNodeR.connect(this.delayFeedbackGainR);
    this.delayFeedbackGainR.connect(this.delayNodeR);
    this.delayNodeR.connect(this.delayMerger, 0, 1);

    this.delayMerger.connect(this.delayWet);

    this.updateDelayMix();

    // Connect dry and wet delay signals into delay output
    this.delayDry.connect(this.delayOut);
    this.delayWet.connect(this.delayOut);
  }

  updateDelayMix() {
    if (!this.ctx || !this.delayDry || !this.delayIn) return;
    const now = this.ctx.currentTime;
    if (this.params.delayEnabled) {
      const mix = this.params.delayMix;
      this.delayIn.gain.setTargetAtTime(1.0, now, 0.02);
      this.delayDry.gain.setTargetAtTime(1.0 - mix * 0.5, now, 0.02);
      this.delayWet.gain.setTargetAtTime(mix, now, 0.02);
    } else {
      this.delayIn.gain.setTargetAtTime(0.0, now, 0.02);
      this.delayDry.gain.setTargetAtTime(1.0, now, 0.02);
      this.delayWet.gain.setTargetAtTime(0.0, now, 0.02);
    }
  }

  setupReverbEffect() {
    this.reverbConvolver = null;
    this._currentReverbDuration = null;
    this.reverbIn = this.ctx.createGain();
    this.reverbDry = this.ctx.createGain();
    this.reverbWet = this.ctx.createGain();
    this.reverbOut = this.ctx.createGain();

    this.reverbFilter = this.ctx.createBiquadFilter();
    this.reverbFilter.type = "lowpass";
    this.reverbFilter.frequency.setValueAtTime(
      this.params.reverbDamp,
      this.ctx.currentTime,
    );
    this.reverbFilter.connect(this.reverbWet);

    this.updateReverbImpulse(this.params.reverbTime);
    this.updateReverbMix();

    this.reverbDry.connect(this.reverbOut);
    this.reverbWet.connect(this.reverbOut);
  }

  updateReverbImpulse(duration = 2.0) {
    if (!this.ctx || !this.reverbIn || !this.reverbFilter) return;
    const key = Math.round(Math.min(Math.max(0.2, duration), 6.0) * 10) / 10;
    if (this._currentReverbDuration === key && this.reverbConvolver) return;
    this._currentReverbDuration = key;

    try {
      const newConvolver = this.ctx.createConvolver();
      newConvolver.buffer = this.buildImpulseResponse(key);

      if (this.reverbConvolver) {
        try {
          this.reverbIn.disconnect(this.reverbConvolver);
          this.reverbConvolver.disconnect();
        } catch (_) {}
      }

      this.reverbConvolver = newConvolver;
      this.reverbIn.connect(this.reverbConvolver);
      this.reverbConvolver.connect(this.reverbFilter);
    } catch (e) {
      console.warn("Reverb buffer setup error:", e);
    }
  }

  buildImpulseResponse(duration = 2.0) {
    if (this._impulseCache && this._impulseCacheSampleRate !== this.ctx.sampleRate) {
      this._impulseCache = null;
    }
    if (!this._impulseCache) {
      this._impulseCache = new Map();
      this._impulseCacheSampleRate = this.ctx.sampleRate;
    }
    const key = Math.round(Math.min(Math.max(0.2, duration), 6.0) * 10) / 10;
    if (this._impulseCache.has(key)) {
      return this._impulseCache.get(key);
    }

    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * key);
    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const decay = Math.exp(-3.5 * (i / length));
      left[i] = (Math.random() * 2 - 1) * decay;
      right[i] = (Math.random() * 2 - 1) * decay;
    }

    this._impulseCache.set(key, impulse);
    return impulse;
  }

  updateReverbMix() {
    if (!this.ctx || !this.reverbDry || !this.reverbIn) return;
    const now = this.ctx.currentTime;
    if (this.params.reverbEnabled) {
      const mix = this.params.reverbMix;
      this.reverbIn.gain.setTargetAtTime(1.0, now, 0.02);
      this.reverbDry.gain.setTargetAtTime(1.0 - mix * 0.3, now, 0.02);
      this.reverbWet.gain.setTargetAtTime(mix, now, 0.02);
    } else {
      this.reverbIn.gain.setTargetAtTime(0.0, now, 0.02);
      this.reverbDry.gain.setTargetAtTime(1.0, now, 0.02);
      this.reverbWet.gain.setTargetAtTime(0.0, now, 0.02);
    }
  }

  createSoftClipCurve(samples = 512) {
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / (samples - 1) - 1; // -1 to +1
      // Smooth hyperbolic tangent transfer curve: perfectly linear up to ~0.7,
      // then progressively saturates to prevent harsh digital DAC clipping
      curve[i] = Math.tanh(x * 1.1) / Math.tanh(1.1);
    }
    return curve;
  }

  connectAudioGraph() {
    // Signal chain: voicesBus -> Distortion -> Cab Sim -> Stereo Delay -> Reverb -> Limiter -> Master Gain -> Clipper -> Destination
    this.voicesBus.connect(this.distDry);
    this.voicesBus.connect(this.distIn);

    // Distortion output routes into Cab Sim:
    this.distOut.connect(this.cabDry);
    this.distOut.connect(this.cabIn);

    // Cab Sim output routes into Delay:
    this.cabOut.connect(this.delayDry);
    this.cabOut.connect(this.delayIn);

    this.delayOut.connect(this.reverbDry);
    this.delayOut.connect(this.reverbIn);

    this.reverbOut.connect(this.masterLimiter);
    this.masterLimiter.connect(this.masterGain);
    this.masterGain.connect(this.masterClipper);
    this.masterClipper.connect(this.ctx.destination);
    // Parallel tap to visualizer analyser
    this.masterClipper.connect(this.analyser);
  }

  setupLFO() {
    this.lfoRunning = false;
    this.lfoPhase = 0;
    this.lfoLastTime = performance.now();
    this.checkLFORunning();
  }

  checkLFORunning() {
    if (this.params.lfoDepth > 0.005 && this.params.lfoTarget !== "none") {
      if (!this.lfoRunning) {
        this.lfoRunning = true;
        this.lfoLastTime = performance.now();
        this.runLFOStep();
      }
    } else {
      this.lfoRunning = false;
    }
  }

  runLFOStep() {
    if (!this.lfoRunning) return;

    const now = performance.now();
    const delta = (now - this.lfoLastTime) / 1000;
    this.lfoLastTime = now;

    this.lfoPhase += delta * this.params.lfoRate * Math.PI * 2;
    if (this.lfoPhase > Math.PI * 2) this.lfoPhase -= Math.PI * 2;

    let val = 0;
    if (this.params.lfoWaveform === "sine") {
      val = Math.sin(this.lfoPhase);
    } else if (this.params.lfoWaveform === "triangle") {
      val = Math.asin(Math.sin(this.lfoPhase)) / (Math.PI / 2);
    } else if (this.params.lfoWaveform === "square") {
      val = Math.sin(this.lfoPhase) >= 0 ? 1 : -1;
    } else if (this.params.lfoWaveform === "sawtooth") {
      val = 1 - 2 * (this.lfoPhase / (Math.PI * 2));
    }

    const modValue = val * this.params.lfoDepth;

    if (this.params.lfoTarget === "pitch") {
      const semitones = modValue * 1.2;
      for (const voice of this.voices) {
        if (voice.isActive) {
          voice.updateFrequencies(this.ctx.currentTime, semitones);
        }
      }
    } else if (this.params.lfoTarget === "filter") {
      const octaveMod = modValue * 2.0;
      for (const voice of this.voices) {
        if (voice.isActive && voice.filter) {
          const base = voice.calculateTargetCutoff(
            this.params.filterSustain || 0.3,
          );
          const target = Math.max(
            20,
            Math.min(20000, base * Math.pow(2, octaveMod)),
          );
          voice.filter.frequency.setTargetAtTime(
            target,
            this.ctx.currentTime,
            0.005,
          );
        }
      }
    }

    requestAnimationFrame(() => this.runLFOStep());
  }

  // --- Voice Allocation & Polyphony ---

  /**
   * Finds the best voice to allocate for a new note:
   * 1. If in guitar mode, gracefully chokes any existing voice sounding this exact pitch over 12ms.
   * 2. If active held voices >= max polyphony (4 or 8), chokes the oldest active voice over 12ms.
   * 3. Allocates a completely fresh, idle voice from the pool for 100% pop-free note onset.
   */
  allocateVoice(note, channel) {
    const isGuitar = this.params?.voiceMode === "guitar";
    const maxVoices = this.voiceCount || 8;

    // 1. In guitar mode, if another voice is actively sounding this exact pitch,
    // gracefully choke it over 12ms so the new pluck replaces it without out-of-phase comb filtering
    if (isGuitar) {
      for (const v of this.voices) {
        if (v.isActive && v.note === note && !v.isChoking) {
          v.choke(0.012);
        }
      }
    }

    // 2. Count actively sounding/held voices (excluding releasing and choking voices)
    const activeHeldVoices = this.voices.filter(
      (v) => v.isActive && !v.isReleasing && !v.isChoking,
    );

    // 3. If we have reached the max polyphony limit (e.g. 4 or 8),
    // gracefully steal (choke) the oldest active held voice over 12ms!
    if (activeHeldVoices.length >= maxVoices) {
      let oldestTime = Infinity;
      let oldestVoice = null;
      for (const v of activeHeldVoices) {
        if (v.noteOnTime < oldestTime) {
          oldestTime = v.noteOnTime;
          oldestVoice = v;
        }
      }
      if (oldestVoice) {
        oldestVoice.choke(0.012);
      }
    }

    // 4. Find the best available voice in the pool:
    // A. Prioritize completely idle voices
    for (const v of this.voices) {
      if (!v.isActive) {
        return v;
      }
    }

    // B. Prioritize oldest voice in release phase that is not choking
    let oldestReleaseTime = Infinity;
    let oldestReleaseVoice = null;
    for (const v of this.voices) {
      if (v.isReleasing && !v.isChoking && v.noteOffTime < oldestReleaseTime) {
        oldestReleaseTime = v.noteOffTime;
        oldestReleaseVoice = v;
      }
    }
    if (oldestReleaseVoice) return oldestReleaseVoice;

    // C. Fallback: Oldest voice in the pool
    let oldestPoolTime = Infinity;
    let fallbackVoice = this.voices[0];
    for (const v of this.voices) {
      if (v.noteOnTime < oldestPoolTime) {
        oldestPoolTime = v.noteOnTime;
        fallbackVoice = v;
      }
    }
    return fallbackVoice;
  }

  // --- MIDI & MPE Message Handlers ---

  noteOn(note, velocity = 0.8, channel = 1) {
    if (!this.ctx) {
      if (this.isAudioStarted) {
        this.recoverAudioEngine(true).then(() => {
          this.noteOn(note, velocity, channel);
        });
      }
      return;
    }

    if (this.ctx.state === "suspended" || this.ctx.state === "interrupted") {
      this.ctx.resume().catch(() => {});
    }

    // Check for frozen hardware clock when receiving notes after device sleep
    const nowPerf = performance.now();
    if (this._lastNotePerf && nowPerf - this._lastNotePerf > 1200) {
      if (
        this._lastNoteAudioTime !== undefined &&
        this.ctx.currentTime === this._lastNoteAudioTime
      ) {
        console.warn(
          "[SynthEngine] Frozen audio clock detected in noteOn! Triggering audio recovery...",
        );
        this._lastNotePerf = nowPerf;
        this.recoverAudioEngine(true).then(() => {
          this.noteOn(note, velocity, channel);
        });
        return;
      }
    }
    this._lastNotePerf = nowPerf;
    this._lastNoteAudioTime = this.ctx.currentTime;

    const voice = this.allocateVoice(note, channel);

    // Inherit current CC state for this voice
    const activeVolumeCC = Number(this.params.volumeCC) || 11;
    const initialVolume =
      activeVolumeCC === 7 ? (this.globalCC7 ?? 127) : (this.globalCC11 ?? 127);
    voice.cc73Cutoff = this.globalCC73;
    voice.cc74Timbre = this.globalCC74;
    voice.cc1Resonance = this.globalCC1;
    voice.cc11Expression = initialVolume;

    voice.noteOn(note, velocity, channel, this.params);
    this.notifyVoiceState();
    return voice;
  }

  noteOff(note, channel = 1) {
    if (!this.ctx) return;

    let released = false;
    for (const voice of this.voices) {
      // In MPE, matching by channel is paramount; also match note (skip voices that are already choking)
      if (voice.isActive && voice.note === note && !voice.isChoking) {
        if (voice.channel === channel || channel === 1 || voice.channel === 1) {
          voice.noteOff();
          released = true;
        }
      }
    }

    // Fallback: if exact channel match didn't find it, match any voice with this note
    if (!released) {
      for (const voice of this.voices) {
        if (voice.isActive && voice.note === note && !voice.isChoking) {
          voice.noteOff();
        }
      }
    }

    this.notifyVoiceState();
  }

  /**
   * Emergency panic: immediately silences and releases all voices.
   */
  panic() {
    for (const voice of this.voices) {
      if (voice.isActive) {
        voice.choke(0.008);
      }
    }

    this.notifyVoiceState();
  }

  /**
   * Handles 14-bit pitch bend for a specific channel.
   * In MPE:
   * - Master Channel (usually 1): affects all voices
   * - Member Channels (2-16): affects only voice(s) playing on that channel
   */
  setPitchBend(channel, rawValue) {
    // rawValue is 0..16383, center is 8192
    const normalized = (rawValue - 8192) / 8192; // -1.0 to +1.0
    const semitones = normalized * (this.params.mpePitchBendRange || 48);

    const isMaster = channel === this.params.mpeMasterChannel;

    for (const voice of this.voices) {
      if (voice.isActive) {
        if (isMaster || voice.channel === channel) {
          voice.setPitchBend(semitones);
        }
      }
    }
  }

  /**
   * Handles Control Change (CC) messages.
   * CC73 / CC74: Filter Cutoff / MPE Timbre
   * CC1: Mod Wheel -> Resonance
   * CC11: Expression -> Volume
   */
  setCC(channel, ccNumber, value) {
    const isMaster = channel === this.params.mpeMasterChannel;

    if (ccNumber === 73 || ccNumber === 74) {
      // CC73 & CC74: Filter Cutoff / MPE Timbre (Y-Axis)
      this.globalCC73 = value;
      this.globalCC74 = value;
      const targetMode = this.params.mpeTimbreTarget || "cutoff";

      if (isMaster && targetMode === "cutoff") {
        const minLog = Math.log(20);
        const maxLog = Math.log(20000);
        const targetCutoff = Math.exp(
          minLog + (value / 127) * (maxLog - minLog),
        );
        // If UI ballistic slew is active, let UI smoothly interpolate params.filterCutoff
        // to avoid race-condition jitter between raw MIDI stepping and visualizer
        if (!this.hasSmoothCutoff) {
          this.params.filterCutoff = targetCutoff;
        }
      } else if (targetMode === "lforate") {
        const minLog = Math.log(0.1);
        const maxLog = Math.log(20.0);
        const rate = +Math.exp(
          minLog + (value / 127) * (maxLog - minLog),
        ).toFixed(1);
        this.params.lfoRate = rate;
      } else if (targetMode === "lfodepth") {
        this.params.lfoDepth = +Math.max(0, Math.min(1.0, value / 127)).toFixed(
          2,
        );
      }

      for (const voice of this.voices) {
        if (isMaster || voice.channel === channel) {
          voice.setCC(ccNumber, value);
        }
      }
    } else if (ccNumber === 1) {
      // CC1: Mod Wheel -> Filter Resonance OR LFO Rate based on cc1Target setting
      this.globalCC1 = value;
      if (this.params.cc1Target === "lforate") {
        const minLog = Math.log(0.1);
        const maxLog = Math.log(20.0);
        const rate = +Math.exp(
          minLog + (value / 127) * (maxLog - minLog),
        ).toFixed(1);
        this.params.lfoRate = rate;
        if (this.lfoOsc) {
          this.lfoOsc.frequency.setTargetAtTime(
            rate,
            this.ctx.currentTime,
            0.02,
          );
        }
      } else {
        const targetQ = +(0.1 + (value / 127) * 19.9).toFixed(1);
        this.params.filterResonance = targetQ;
        for (const voice of this.voices) {
          if (isMaster || voice.channel === channel) {
            voice.setCC(1, value);
          }
        }
      }
    } else if (ccNumber === 11 || ccNumber === 7) {
      // Volume control (assigned to CC11 Expression or CC7 Channel Volume)
      const activeVolumeCC = Number(this.params.volumeCC) || 11;
      if (ccNumber === 7) this.globalCC7 = value;
      if (ccNumber === 11) this.globalCC11 = value;

      // If incoming CC matches the configured volume CC (or if either was sent), route to voices
      if (ccNumber === activeVolumeCC) {
        for (const voice of this.voices) {
          if (isMaster || voice.channel === channel) {
            voice.setCC(activeVolumeCC, value);
          }
        }
      }
    }
  }

  /**
   * Handles Channel Pressure (Aftertouch).
   */
  setPressure(channel, value) {
    const isMaster = channel === this.params.mpeMasterChannel;
    for (const voice of this.voices) {
      if (voice.isActive && (isMaster || voice.channel === channel)) {
        voice.setPressure(value);
      }
    }
  }

  /**
   * Handles Polyphonic Key Pressure (Poly Aftertouch).
   */
  setPolyPressure(channel, note, value) {
    for (const voice of this.voices) {
      if (
        voice.isActive &&
        voice.note === note &&
        (voice.channel === channel || channel === 1 || voice.channel === 1)
      ) {
        voice.setPressure(value);
      }
    }
  }

  notifyVoiceState() {
    if (typeof this.onVoiceStateChange === "function") {
      const states = this.voices.map((v) => ({
        id: v.id,
        isActive: v.isActive,
        isReleasing: v.isReleasing,
        note: v.note,
        channel: v.channel,
        velocity: v.velocity,
      }));
      this.onVoiceStateChange(states);
    }
  }

  // --- Parameter Updates ---

  updateParam(key, value) {
    this.params[key] = value;

    if (key === "masterVolume" && this.masterGain) {
      const scaledVol = value * (this.masterHeadroomGain || 0.82);
      this.masterGain.gain.setTargetAtTime(
        scaledVol,
        this.ctx.currentTime,
        0.01,
      );
    } else if (key === "distortionEnabled" || key === "distortionMix") {
      this.updateDistortionMix();
    } else if (key === "cabSimEnabled") {
      this.updateCabSimMix();
    } else if (key === "cabSimType") {
      this.updateCabSimProfile(value);
      this.updateCabSimMix();
    } else if (key === "distortionDrive" && this.distWaveShaper) {
      this.distWaveShaper.curve = this.makeDistortionCurve(value);
    } else if (key === "distortionTone" && this.distFilter) {
      this.distFilter.frequency.setTargetAtTime(
        value,
        this.ctx.currentTime,
        0.02,
      );
    } else if (key === "delayEnabled" || key === "delayMix") {
      this.updateDelayMix();
    } else if (key === "delayTime" && this.delayNodeL) {
      this.delayNodeL.delayTime.setTargetAtTime(
        value,
        this.ctx.currentTime,
        0.02,
      );
      this.delayNodeR.delayTime.setTargetAtTime(
        value * 1.33,
        this.ctx.currentTime,
        0.02,
      );
    } else if (key === "delayFeedback" && this.delayFeedbackGainL) {
      this.delayFeedbackGainL.gain.setTargetAtTime(
        value,
        this.ctx.currentTime,
        0.02,
      );
      this.delayFeedbackGainR.gain.setTargetAtTime(
        value,
        this.ctx.currentTime,
        0.02,
      );
    } else if (key === "reverbEnabled" || key === "reverbMix") {
      this.updateReverbMix();
    } else if (key === "reverbTime") {
      this.updateReverbImpulse(value);
    } else if (key === "reverbDamp" && this.reverbFilter) {
      this.reverbFilter.frequency.setTargetAtTime(
        value,
        this.ctx.currentTime,
        0.02,
      );
    } else if (key === "lfoRate" && this.lfoOsc) {
      this.lfoOsc.frequency.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    } else if (key === "lfoDepth" || key === "lfoTarget") {
      this.checkLFORunning();
    }

    // Broadcast updated params to all active voices
    for (const voice of this.voices) {
      if (voice.isActive) {
        voice.updateParams(this.params);
      }
    }

    if (this.onParamChange) {
      this.onParamChange(key, value);
    }
  }

  applyPreset(preset) {
    // Read cabSimEnabled, cabSimType, pickTransient, and voiceMode explicitly from preset definition
    this.params.cabSimEnabled = Boolean(preset.params?.cabSimEnabled);
    this.params.cabSimType = preset.params?.cabSimType || "1x12";
    this.params.pickTransient =
      typeof preset.params?.pickTransient === "number"
        ? preset.params.pickTransient
        : preset.params?.pickTransient
          ? 0.75
          : 0.0;
    this.params.voiceMode = preset.params?.voiceMode || "analog";

    Object.assign(this.params, preset.params);
    this.checkLFORunning();

    if (this.masterGain) {
      const scaledVol =
        (this.params.masterVolume ?? 0.75) * (this.masterHeadroomGain || 0.82);
      this.masterGain.gain.setTargetAtTime(
        scaledVol,
        this.ctx.currentTime,
        0.02,
      );
    }

    this.updateDistortionMix();
    this.updateCabSimMix();
    this.updateCabSimProfile(this.params.cabSimType);
    if (this.distWaveShaper) {
      const drive = this.params.distortionDrive ?? 20;
      if (this._currentDistDrive !== drive) {
        this._currentDistDrive = drive;
        this.distWaveShaper.curve = this.makeDistortionCurve(drive);
      }
    }
    if (this.distFilter) {
      this.distFilter.frequency.setTargetAtTime(
        this.params.distortionTone ?? 4000,
        this.ctx.currentTime,
        0.02,
      );
    }

    this.updateDelayMix();
    if (this.delayNodeL) {
      this.delayNodeL.delayTime.setTargetAtTime(
        this.params.delayTime,
        this.ctx.currentTime,
        0.02,
      );
      this.delayNodeR.delayTime.setTargetAtTime(
        this.params.delayTime * 1.33,
        this.ctx.currentTime,
        0.02,
      );
      this.delayFeedbackGainL.gain.setTargetAtTime(
        this.params.delayFeedback,
        this.ctx.currentTime,
        0.02,
      );
      this.delayFeedbackGainR.gain.setTargetAtTime(
        this.params.delayFeedback,
        this.ctx.currentTime,
        0.02,
      );
    }

    this.updateReverbMix();
    if (this.params.reverbEnabled && this.params.reverbTime) {
      if (this._reverbUpdateTimeout) clearTimeout(this._reverbUpdateTimeout);
      this._reverbUpdateTimeout = setTimeout(() => {
        this.updateReverbImpulse(this.params.reverbTime);
      }, 120);
    }
    if (this.reverbFilter && this.params.reverbDamp) {
      this.reverbFilter.frequency.setTargetAtTime(
        this.params.reverbDamp,
        this.ctx.currentTime,
        0.02,
      );
    }

    for (const voice of this.voices) {
      if (voice.isActive) {
        voice.updateParams(this.params);
      }
    }
  }
}
