import { SynthVoice } from './synth-voice.js';

/**
 * SynthEngine: Orchestrates the 8-voice polyphonic synthesizer,
 * master audio effects graph, MPE routing, and preset management.
 */
export class SynthEngine {
  constructor() {
    this.ctx = null;
    this.isAudioStarted = false;
    this.bufferMode = localStorage.getItem('synth_buffer_mode') || 'ultralow';
    this.voiceCount = parseInt(localStorage.getItem('synth_voice_count') || '8', 10);
    this.voices = [];
    this.onVoiceStateChange = null; // Callback for UI voice meters
    this.onBufferStatChange = null; // Callback for UI buffer stats

    // Global / Active synth parameters
    this.params = {
      // Oscillators
      osc1Waveform: 'sawtooth',
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: 0,

      osc2Waveform: 'sawtooth',
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
      lfoWaveform: 'sine',
      lfoRate: 3.5, // Hz
      lfoDepth: 0.0, // 0 to 1
      lfoTarget: 'filter', // 'filter', 'pitch', 'amp', 'none'

      // Distortion Effect
      distortionEnabled: false,
      distortionDrive: 20, // 1 to 80
      distortionTone: 4000, // 500 Hz to 12000 Hz
      distortionMix: 0.5,

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
      mpeMasterChannel: 1
    };

    // Controller states
    this.globalCC73 = 64;
    this.globalCC1 = 0;
    this.globalCC11 = 127;
  }

  /**
   * Initializes the Web Audio context and audio graph.
   */
  async initAudio() {
    if (this.isAudioStarted && this.ctx) {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    // Configurable buffer latency:
    // 'balanced' (default 25ms): rock solid on Android / Moto G 5G, zero crackles
    // 'interactive' (10ms): low latency for iOS / Pixel / PC
    // 'ultralow' (0): raw hardware minimum (<5ms)
    // 'safe' (50ms): maximum safety buffer for heavy load
    let latencyOption = 0.025;
    if (this.bufferMode === 'ultralow') {
      latencyOption = 0;
    } else if (this.bufferMode === 'interactive') {
      latencyOption = 'interactive';
    } else if (this.bufferMode === 'balanced') {
      latencyOption = 0.025;
    } else if (this.bufferMode === 'safe') {
      latencyOption = 0.05;
    }

    this.ctx = new AudioContextClass({ latencyHint: latencyOption });
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.masterHeadroomGain = 0.82; // -1.7 dBFS headroom prevents digital clipping at max volume

    // 1. Voices Summing Bus (0.75 scaling prevents multi-voice clipping)
    this.voicesBus = this.ctx.createGain();
    this.voicesBus.gain.setValueAtTime(0.75, this.ctx.currentTime);

    // 2. Effects Processing Chain (Distortion -> Stereo Delay -> Reverb)
    this.setupDistortionEffect();
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
    this.masterGain.gain.setValueAtTime(this.params.masterVolume * this.masterHeadroomGain, this.ctx.currentTime);

    // 5. Soft-Clipper Stage (musical saturation safety ceiling before DAC)
    this.masterClipper = this.ctx.createWaveShaper();
    this.masterClipper.curve = this.createSoftClipCurve(512);
    this.masterClipper.oversample = '2x';

    // 6. Analyser Node for Visualizer
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    // Connect audio signal chain:
    // voicesBus -> dry/wet delay network -> masterLimiter -> masterGain -> masterClipper -> destination (parallel analyser)
    this.connectAudioGraph();

    // 6. Pre-allocate Polyphonic Voices (4 or 8)
    this.voices = [];
    for (let i = 0; i < this.voiceCount; i++) {
      this.voices.push(new SynthVoice(this.ctx, this.voicesBus, i));
    }

    // 7. LFO Engine Setup
    this.setupLFO();

    this.isAudioStarted = true;

    // Report measured hardware buffer latency
    if (this.onBufferStatChange) {
      const ms = this.ctx.baseLatency ? (this.ctx.baseLatency * 1000).toFixed(1) : (latencyOption * 1000).toFixed(0);
      this.onBufferStatChange(ms);
    }
  }

  /**
   * Reconfigures audio buffer mode or polyphony voice count dynamically.
   */
  async reconfigureAudio(bufferMode = null, voiceCount = null) {
    if (bufferMode) {
      this.bufferMode = bufferMode;
      localStorage.setItem('synth_buffer_mode', bufferMode);
    }
    if (voiceCount) {
      this.voiceCount = parseInt(voiceCount, 10);
      localStorage.setItem('synth_voice_count', this.voiceCount.toString());
    }

    if (this.isAudioStarted && this.ctx) {
      this.panic();
      try {
        await this.ctx.close();
      } catch (_) {}
      this.ctx = null;
      this.isAudioStarted = false;
      await this.initAudio();
    }
  }

  // --- Effects Implementation (Distortion, Delay, Reverb) ---

  setupDistortionEffect() {
    this.distIn = this.ctx.createGain();
    this.distDry = this.ctx.createGain();
    this.distWet = this.ctx.createGain();
    this.distOut = this.ctx.createGain();

    this.distWaveShaper = this.ctx.createWaveShaper();
    this.distWaveShaper.curve = this.makeDistortionCurve(this.params.distortionDrive);
    this.distWaveShaper.oversample = '2x';

    this.distFilter = this.ctx.createBiquadFilter();
    this.distFilter.type = 'lowpass';
    this.distFilter.frequency.setValueAtTime(this.params.distortionTone, this.ctx.currentTime);

    // Wet chain: distIn -> distWaveShaper -> distFilter -> distWet
    this.distIn.connect(this.distWaveShaper);
    this.distWaveShaper.connect(this.distFilter);
    this.distFilter.connect(this.distWet);

    this.updateDistortionMix();

    this.distDry.connect(this.distOut);
    this.distWet.connect(this.distOut);
  }

  makeDistortionCurve(amount = 20) {
    const k = Math.max(0, amount);
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      if (k === 0) {
        curve[i] = x;
      } else {
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
      }
    }
    return curve;
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
    this.delayNodeL.delayTime.setValueAtTime(this.params.delayTime, this.ctx.currentTime);

    // Right delay (offset slightly for stereo field)
    this.delayNodeR = this.ctx.createDelay(2.0);
    this.delayNodeR.delayTime.setValueAtTime(this.params.delayTime * 1.33, this.ctx.currentTime);

    // Feedback gains
    this.delayFeedbackGainL = this.ctx.createGain();
    this.delayFeedbackGainR = this.ctx.createGain();
    this.delayFeedbackGainL.gain.setValueAtTime(this.params.delayFeedback, this.ctx.currentTime);
    this.delayFeedbackGainR.gain.setValueAtTime(this.params.delayFeedback, this.ctx.currentTime);

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
    this.delaySplitter.connect(this.delayNodeR, 1 % this.delaySplitter.numberOfOutputs);
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
    this.reverbIn = this.ctx.createGain();
    this.reverbDry = this.ctx.createGain();
    this.reverbWet = this.ctx.createGain();
    this.reverbOut = this.ctx.createGain();

    this.reverbFilter = this.ctx.createBiquadFilter();
    this.reverbFilter.type = 'lowpass';
    this.reverbFilter.frequency.setValueAtTime(this.params.reverbDamp, this.ctx.currentTime);
    this.reverbFilter.connect(this.reverbWet);

    this.updateReverbImpulse(this.params.reverbTime);
    this.updateReverbMix();

    this.reverbDry.connect(this.reverbOut);
    this.reverbWet.connect(this.reverbOut);
  }

  updateReverbImpulse(duration = 2.0) {
    if (!this.ctx || !this.reverbIn || !this.reverbFilter) return;
    try {
      const newConvolver = this.ctx.createConvolver();
      newConvolver.buffer = this.buildImpulseResponse(duration);

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
      console.warn('Reverb buffer setup error:', e);
    }
  }

  buildImpulseResponse(duration = 2.0) {
    const rate = this.ctx.sampleRate;
    const dur = Math.min(Math.max(0.2, duration), 6.0);
    const length = Math.floor(rate * dur);
    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const decay = Math.exp(-3.5 * (i / length));
      left[i] = (Math.random() * 2 - 1) * decay;
      right[i] = (Math.random() * 2 - 1) * decay;
    }
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
    // Signal chain: voicesBus -> Distortion -> Stereo Delay -> Reverb -> Limiter -> Master Gain -> Clipper -> Destination
    this.voicesBus.connect(this.distDry);
    this.voicesBus.connect(this.distIn);

    this.distOut.connect(this.delayDry);
    this.distOut.connect(this.delayIn);

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
    if (this.params.lfoDepth > 0.005 && this.params.lfoTarget !== 'none') {
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
    if (this.params.lfoWaveform === 'sine') {
      val = Math.sin(this.lfoPhase);
    } else if (this.params.lfoWaveform === 'triangle') {
      val = Math.asin(Math.sin(this.lfoPhase)) / (Math.PI / 2);
    } else if (this.params.lfoWaveform === 'square') {
      val = Math.sin(this.lfoPhase) >= 0 ? 1 : -1;
    } else if (this.params.lfoWaveform === 'sawtooth') {
      val = 1 - 2 * (this.lfoPhase / (Math.PI * 2));
    }

    const modValue = val * this.params.lfoDepth;

    if (this.params.lfoTarget === 'pitch') {
      const semitones = modValue * 1.2;
      for (const voice of this.voices) {
        if (voice.isActive) {
          voice.updateFrequencies(this.ctx.currentTime, semitones);
        }
      }
    } else if (this.params.lfoTarget === 'filter') {
      const octaveMod = modValue * 2.0;
      for (const voice of this.voices) {
        if (voice.isActive && voice.filter) {
          const base = voice.calculateTargetCutoff(this.params.filterSustain || 0.3);
          const target = Math.max(20, Math.min(20000, base * Math.pow(2, octaveMod)));
          voice.filter.frequency.setTargetAtTime(target, this.ctx.currentTime, 0.005);
        }
      }
    }

    requestAnimationFrame(() => this.runLFOStep());
  }

  // --- Voice Allocation & Polyphony ---

  /**
   * Finds the best voice to allocate for a new note:
   * 1. Idle voice
   * 2. Oldest releasing voice
   * 3. Oldest active voice (Voice Stealing / LRU)
   */
  allocateVoice(note, channel) {
    // 1. If a voice is already actively held playing this note on this channel (not in release),
    // re-trigger that same voice instead of consuming another polyphony slot.
    for (const voice of this.voices) {
      if (voice.isActive && !voice.isReleasing && voice.note === note && voice.channel === channel) {
        return voice;
      }
    }

    // 2. Prioritize completely idle voices so repeated note strikes don't choke previous tails
    for (const voice of this.voices) {
      if (!voice.isActive) {
        return voice;
      }
    }

    // 3. Prioritize oldest voice in release phase
    let oldestReleaseTime = Infinity;
    let oldestReleaseVoice = null;
    for (const voice of this.voices) {
      if (voice.isReleasing && voice.noteOffTime < oldestReleaseTime) {
        oldestReleaseTime = voice.noteOffTime;
        oldestReleaseVoice = voice;
      }
    }
    if (oldestReleaseVoice) return oldestReleaseVoice;

    // 4. Steal oldest active voice (LRU)
    let oldestNoteTime = Infinity;
    let oldestVoice = this.voices[0];
    for (const voice of this.voices) {
      if (voice.noteOnTime < oldestNoteTime) {
        oldestNoteTime = voice.noteOnTime;
        oldestVoice = voice;
      }
    }
    return oldestVoice;
  }

  // --- MIDI & MPE Message Handlers ---

  noteOn(note, velocity = 0.8, channel = 1) {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();

    const voice = this.allocateVoice(note, channel);
    // Inherit current CC state for this voice
    voice.cc73Cutoff = this.globalCC73;
    voice.cc1Resonance = this.globalCC1;
    voice.cc11Expression = this.globalCC11;

    voice.noteOn(note, velocity, channel, this.params);
    this.notifyVoiceState();
    return voice;
  }

  noteOff(note, channel = 1) {
    if (!this.ctx) return;

    let released = false;
    for (const voice of this.voices) {
      // In MPE, matching by channel is paramount; also match note
      if (voice.isActive && voice.note === note) {
        if (voice.channel === channel || channel === 1 || voice.channel === 1) {
          voice.noteOff();
          released = true;
        }
      }
    }

    // Fallback: if exact channel match didn't find it, match any voice with this note
    if (!released) {
      for (const voice of this.voices) {
        if (voice.isActive && voice.note === note) {
          voice.noteOff();
        }
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
   * CC73: Filter Cutoff
   * CC1: Mod Wheel -> Resonance
   * CC11: Expression -> Volume
   */
  setCC(channel, ccNumber, value) {
    const isMaster = channel === this.params.mpeMasterChannel;

    if (ccNumber === 73) {
      // CC73: Cutoff
      this.globalCC73 = value;
      for (const voice of this.voices) {
        if (isMaster || voice.channel === channel) {
          voice.setCC(73, value);
        }
      }
    } else if (ccNumber === 1) {
      // CC1: Mod Wheel -> Resonance
      this.globalCC1 = value;
      for (const voice of this.voices) {
        if (isMaster || voice.channel === channel) {
          voice.setCC(1, value);
        }
      }
    } else if (ccNumber === 11) {
      // CC11: Expression -> Volume
      this.globalCC11 = value;
      for (const voice of this.voices) {
        if (isMaster || voice.channel === channel) {
          voice.setCC(11, value);
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
   * Emergency Panic: Kills all active voices immediately.
   */
  panic() {
    for (const voice of this.voices) {
      voice.kill();
    }
    this.notifyVoiceState();
  }

  notifyVoiceState() {
    if (typeof this.onVoiceStateChange === 'function') {
      const states = this.voices.map(v => ({
        id: v.id,
        isActive: v.isActive,
        isReleasing: v.isReleasing,
        note: v.note,
        channel: v.channel,
        velocity: v.velocity
      }));
      this.onVoiceStateChange(states);
    }
  }

  // --- Parameter Updates ---

  updateParam(key, value) {
    this.params[key] = value;

    if (key === 'masterVolume' && this.masterGain) {
      const scaledVol = value * (this.masterHeadroomGain || 0.82);
      this.masterGain.gain.setTargetAtTime(scaledVol, this.ctx.currentTime, 0.01);
    } else if (key === 'distortionEnabled' || key === 'distortionMix') {
      this.updateDistortionMix();
    } else if (key === 'distortionDrive' && this.distWaveShaper) {
      this.distWaveShaper.curve = this.makeDistortionCurve(value);
    } else if (key === 'distortionTone' && this.distFilter) {
      this.distFilter.frequency.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    } else if (key === 'delayEnabled' || key === 'delayMix') {
      this.updateDelayMix();
    } else if (key === 'delayTime' && this.delayNodeL) {
      this.delayNodeL.delayTime.setTargetAtTime(value, this.ctx.currentTime, 0.02);
      this.delayNodeR.delayTime.setTargetAtTime(value * 1.33, this.ctx.currentTime, 0.02);
    } else if (key === 'delayFeedback' && this.delayFeedbackGainL) {
      this.delayFeedbackGainL.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
      this.delayFeedbackGainR.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    } else if (key === 'reverbEnabled' || key === 'reverbMix') {
      this.updateReverbMix();
    } else if (key === 'reverbTime') {
      this.updateReverbImpulse(value);
    } else if (key === 'reverbDamp' && this.reverbFilter) {
      this.reverbFilter.frequency.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    } else if (key === 'lfoRate' && this.lfoOsc) {
      this.lfoOsc.frequency.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    } else if (key === 'lfoDepth' || key === 'lfoTarget') {
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
    Object.assign(this.params, preset.params);
    this.checkLFORunning();

    if (this.masterGain) {
      const scaledVol = (this.params.masterVolume ?? 0.75) * (this.masterHeadroomGain || 0.82);
      this.masterGain.gain.setTargetAtTime(scaledVol, this.ctx.currentTime, 0.02);
    }

    this.updateDistortionMix();
    if (this.distWaveShaper) {
      this.distWaveShaper.curve = this.makeDistortionCurve(this.params.distortionDrive ?? 20);
    }
    if (this.distFilter) {
      this.distFilter.frequency.setTargetAtTime(this.params.distortionTone ?? 4000, this.ctx.currentTime, 0.02);
    }

    this.updateDelayMix();
    if (this.delayNodeL) {
      this.delayNodeL.delayTime.setTargetAtTime(this.params.delayTime, this.ctx.currentTime, 0.02);
      this.delayNodeR.delayTime.setTargetAtTime(this.params.delayTime * 1.33, this.ctx.currentTime, 0.02);
      this.delayFeedbackGainL.gain.setTargetAtTime(this.params.delayFeedback, this.ctx.currentTime, 0.02);
      this.delayFeedbackGainR.gain.setTargetAtTime(this.params.delayFeedback, this.ctx.currentTime, 0.02);
    }

    this.updateReverbMix();
    if (this.params.reverbTime) {
      this.updateReverbImpulse(this.params.reverbTime);
    }
    if (this.reverbFilter && this.params.reverbDamp) {
      this.reverbFilter.frequency.setTargetAtTime(this.params.reverbDamp, this.ctx.currentTime, 0.02);
    }

    for (const voice of this.voices) {
      if (voice.isActive) {
        voice.updateParams(this.params);
      }
    }
  }
}
