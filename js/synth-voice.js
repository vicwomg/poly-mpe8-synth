/**
 * SynthVoice: Represents one polyphonic voice in the MPE synth pool.
 * Features de-clicked micro-fading on voice stealing/re-triggering to completely
 * eliminate pop and crackle transients when notes are repeatedly triggered.
 */
export class SynthVoice {
  constructor(audioContext, destination, id = 0) {
    this.ctx = audioContext;
    this.destination = destination;
    this.id = id;

    // State
    this.isActive = false;
    this.isReleasing = false;
    this.note = null;
    this.frequency = 440;
    this.velocity = 0;
    this.channel = 1;
    this.noteOnTime = 0;
    this.noteOffTime = 0;

    // Per-voice MPE / Controller state
    this.pitchBend = 0; // In semitones
    this.cc73Cutoff = 64; // Cutoff offset (0..127)
    this.cc1Resonance = 0; // Mod wheel (0..127)
    this.cc11Expression = 127; // Expression volume (0..127)
    this.pressure = 0; // Aftertouch (0..127)

    // Dynamic oscillators (created on noteOn)
    this.osc1 = null;
    this.osc2 = null;

    // Pre-allocated static nodes (persists across notes for minimum latency & zero GC)
    this.osc1Gain = this.ctx.createGain();
    this.osc2Gain = this.ctx.createGain();
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.vca = this.ctx.createGain(); // Dedicated to Amp ADSR Envelope
    this.expressionGain = this.ctx.createGain(); // Dedicated to CC11 Volume & Velocity

    // Audio Graph:
    // osc1 -> osc1Gain \
    //                    -> filter -> vca (ADSR) -> expressionGain (CC11 Volume) -> destination
    // osc2 -> osc2Gain /
    this.osc1Gain.connect(this.filter);
    this.osc2Gain.connect(this.filter);
    this.filter.connect(this.vca);
    this.vca.connect(this.expressionGain);
    this.expressionGain.connect(this.destination);

    // Initial gains
    const now = this.ctx.currentTime;
    this.vca.gain.setValueAtTime(0.0001, now);
    this.expressionGain.gain.setValueAtTime(1.0, now);

    this.params = null;
  }

  /**
   * Triggers a note on this voice.
   * Seamlessly micro-fades any running sound to prevent DC transients/pops.
   */
  noteOn(note, velocity, channel, params) {
    const now = this.ctx.currentTime;
    const wasSounding = this.isActive;

    this.note = note;
    this.velocity = Math.max(0.01, velocity);
    this.channel = channel;
    this.params = params;
    this.isActive = true;
    this.isReleasing = false;
    this.noteOnTime = now;
    this.frequency = 440 * Math.pow(2, (note - 69) / 12);

    // Capture old oscillators to stop them after smooth micro-fade
    const oldOsc1 = this.osc1;
    const oldOsc2 = this.osc2;

    // 1. Instantiate new oscillators
    this.osc1 = this.ctx.createOscillator();
    this.osc2 = this.ctx.createOscillator();
    this.osc1.type = params.osc1Waveform || 'sawtooth';
    this.osc2.type = params.osc2Waveform || 'square';

    // Mix balance
    const osc2Mix = params.osc2Mix !== undefined ? params.osc2Mix : 0.5;
    this.osc1Gain.gain.setValueAtTime(1.0 - osc2Mix * 0.5, now);
    this.osc2Gain.gain.setValueAtTime(osc2Mix, now);

    // Connect to pre-allocated mixer gains
    this.osc1.connect(this.osc1Gain);
    this.osc2.connect(this.osc2Gain);

    // 2. Set frequencies (including pitch bend)
    this.updateFrequencies(now);

    // 3. Set filter cutoff & resonance (with de-click interpolation if was sounding)
    this.updateFilter(now, true, wasSounding);

    // 4. Update Expression Gain (CC11 * velocity)
    this.updateExpression(now);

    // 5. Trigger Amp ADSR Envelope with anti-pop micro-fade
    this.triggerAmpEnvelope(now, wasSounding);

    // 6. Start new oscillators
    // If was sounding, offset start by 2.5ms to crossfade cleanly from zero
    const startTime = wasSounding ? now + 0.0025 : now;
    this.osc1.start(startTime);
    this.osc2.start(startTime);

    // Cleanly stop and disconnect old oscillators after 3.5ms
    if (oldOsc1) {
      try { oldOsc1.stop(now + 0.0035); } catch (_) {}
      setTimeout(() => { try { oldOsc1.disconnect(); } catch (_) {} }, 25);
    }
    if (oldOsc2) {
      try { oldOsc2.stop(now + 0.0035); } catch (_) {}
      setTimeout(() => { try { oldOsc2.disconnect(); } catch (_) {} }, 25);
    }
  }

  /**
   * Releases note and enters ADSR release phase.
   */
  noteOff() {
    if (!this.isActive || this.isReleasing) return;
    this.isReleasing = true;
    this.noteOffTime = this.ctx.currentTime;

    const now = this.ctx.currentTime;
    const ampRelease = Math.max(0.008, this.params?.ampRelease || 0.3);
    const filterRelease = Math.max(0.008, this.params?.filterRelease || 0.3);

    // Release Amp Envelope
    this.vca.gain.cancelScheduledValues(now);
    const currentGain = Math.max(0.0001, this.vca.gain.value);
    this.vca.gain.setValueAtTime(currentGain, now);
    this.vca.gain.exponentialRampToValueAtTime(0.0001, now + ampRelease);

    // Release Filter Envelope
    const baseCutoff = this.calculateTargetCutoff(0);
    this.filter.frequency.cancelScheduledValues(now);
    const currentCutoff = Math.max(20, Math.min(20000, this.filter.frequency.value));
    this.filter.frequency.setValueAtTime(currentCutoff, now);
    this.filter.frequency.exponentialRampToValueAtTime(baseCutoff, now + filterRelease);

    const maxRelease = Math.max(ampRelease, filterRelease);
    const stopTime = now + maxRelease + 0.02;

    if (this.osc1) {
      try { this.osc1.stop(stopTime); } catch (e) {}
    }
    if (this.osc2) {
      try { this.osc2.stop(stopTime); } catch (e) {}
    }

    setTimeout(() => {
      if (this.isReleasing && this.ctx.currentTime >= stopTime - 0.03) {
        this.isActive = false;
        this.isReleasing = false;
        this.stopOscillators();
      }
    }, (maxRelease + 0.05) * 1000);
  }

  /**
   * Immediately silence this voice.
   */
  kill() {
    this.isActive = false;
    this.isReleasing = false;
    this.stopOscillators();
    if (this.vca) {
      this.vca.gain.cancelScheduledValues(this.ctx.currentTime);
      this.vca.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    }
  }

  stopOscillators() {
    if (this.osc1) {
      try { this.osc1.stop(); } catch (e) {}
      try { this.osc1.disconnect(); } catch (e) {}
      this.osc1 = null;
    }
    if (this.osc2) {
      try { this.osc2.stop(); } catch (e) {}
      try { this.osc2.disconnect(); } catch (e) {}
      this.osc2 = null;
    }
  }

  updateFrequencies(time = this.ctx.currentTime, lfoPitchSemitones = 0) {
    if (!this.osc1 || !this.osc2 || !this.params) return;

    const baseFreq = 440 * Math.pow(2, (this.note - 69) / 12);

    // Osc 1
    const osc1Oct = (this.params.osc1Octave || 0) * 12;
    const osc1Semi = this.params.osc1Semi || 0;
    const osc1Fine = (this.params.osc1Fine || 0) / 100;
    const osc1Semitones = osc1Oct + osc1Semi + osc1Fine + this.pitchBend + lfoPitchSemitones;
    const osc1Freq = Math.max(10, Math.min(22050, baseFreq * Math.pow(2, osc1Semitones / 12)));

    // Osc 2
    const osc2Oct = (this.params.osc2Octave || 0) * 12;
    const osc2Semi = this.params.osc2Semi || 0;
    const osc2Fine = (this.params.osc2Fine || 0) / 100;
    const osc2Semitones = osc2Oct + osc2Semi + osc2Fine + this.pitchBend + lfoPitchSemitones;
    const osc2Freq = Math.max(10, Math.min(22050, baseFreq * Math.pow(2, osc2Semitones / 12)));

    this.osc1.frequency.setTargetAtTime(osc1Freq, time, 0.003);
    this.osc2.frequency.setTargetAtTime(osc2Freq, time, 0.003);
  }

  calculateTargetCutoff(envelopeValue = 0) {
    if (!this.params) return 1000;
    const baseCutoff = Math.max(20, Math.min(20000, this.params.filterCutoff || 2000));
    const cc73Octaves = ((this.cc73Cutoff - 64) / 64) * 3.5;
    const keyTracking = (this.params.filterKeyTracking !== undefined ? this.params.filterKeyTracking : 0.4);
    const keyOctaves = ((this.note - 60) / 12) * keyTracking;
    const envAmount = this.params.filterEnvAmount !== undefined ? this.params.filterEnvAmount : 0.5;
    const envOctaves = envelopeValue * envAmount * 5;

    const totalOctaves = cc73Octaves + keyOctaves + envOctaves;
    const freq = baseCutoff * Math.pow(2, totalOctaves);
    return Math.max(20, Math.min(20000, freq));
  }

  updateFilter(time = this.ctx.currentTime, isNoteOn = false, wasSounding = false) {
    if (!this.filter || !this.params) return;

    // Resonance Q: base Q + CC1 (Mod Wheel ONLY!)
    const baseQ = this.params.filterResonance !== undefined ? this.params.filterResonance : 1.0;
    const modWheelQ = (this.cc1Resonance / 127) * 18;
    const totalQ = Math.max(0.1, Math.min(25, baseQ + modWheelQ));
    this.filter.Q.setTargetAtTime(totalQ, time, 0.003);

    if (isNoteOn) {
      const attack = Math.max(0.005, this.params.filterAttack || 0.04);
      const decay = Math.max(0.005, this.params.filterDecay || 0.35);
      const sustain = Math.max(0, Math.min(1, this.params.filterSustain !== undefined ? this.params.filterSustain : 0.3));

      const startFreq = this.calculateTargetCutoff(0);
      const peakFreq = this.calculateTargetCutoff(1.0);
      const sustainFreq = this.calculateTargetCutoff(sustain);

      this.filter.frequency.cancelScheduledValues(time);

      if (wasSounding) {
        // Micro-ramp from current cutoff down to startFreq over 2.5ms to avoid filter register pop
        const currentCutoff = Math.max(20, Math.min(20000, this.filter.frequency.value));
        this.filter.frequency.setValueAtTime(currentCutoff, time);
        this.filter.frequency.linearRampToValueAtTime(startFreq, time + 0.0025);
        this.filter.frequency.exponentialRampToValueAtTime(peakFreq, time + 0.0025 + attack);
        this.filter.frequency.exponentialRampToValueAtTime(sustainFreq, time + 0.0025 + attack + decay);
      } else {
        this.filter.frequency.setValueAtTime(startFreq, time);
        this.filter.frequency.exponentialRampToValueAtTime(peakFreq, time + attack);
        this.filter.frequency.exponentialRampToValueAtTime(sustainFreq, time + attack + decay);
      }
    } else if (!this.isReleasing) {
      const sustain = Math.max(0, Math.min(1, this.params.filterSustain !== undefined ? this.params.filterSustain : 0.3));
      const targetCutoff = this.calculateTargetCutoff(sustain);
      this.filter.frequency.setTargetAtTime(targetCutoff, time, 0.005);
    }
  }

  /**
   * Triggers the amplitude ADSR envelope.
   * If the voice was already sounding, performs a 2.5ms micro-fade to zero
   * before starting the attack, eliminating the step discontinuity DC click.
   */
  triggerAmpEnvelope(time, wasSounding = false) {
    if (!this.vca || !this.params) return;

    const attack = Math.max(0.005, this.params.ampAttack || 0.02);
    const decay = Math.max(0.005, this.params.ampDecay || 0.25);
    const sustain = Math.max(0.0001, Math.min(1.0, this.params.ampSustain !== undefined ? this.params.ampSustain : 0.7));

    this.vca.gain.cancelScheduledValues(time);

    if (wasSounding) {
      const currentGain = Math.max(0.0001, this.vca.gain.value);
      this.vca.gain.setValueAtTime(currentGain, time);
      // Smooth micro-fade to zero (2.5ms)
      this.vca.gain.linearRampToValueAtTime(0.0001, time + 0.0025);
      // Clean attack start from zero
      this.vca.gain.linearRampToValueAtTime(1.0, time + 0.0025 + attack);
      this.vca.gain.exponentialRampToValueAtTime(sustain, time + 0.0025 + attack + decay);
    } else {
      this.vca.gain.setValueAtTime(0.0001, time);
      this.vca.gain.linearRampToValueAtTime(1.0, time + attack);
      this.vca.gain.exponentialRampToValueAtTime(sustain, time + attack + decay);
    }
  }

  /**
   * Strictly controls Volume via CC11 and Note Velocity.
   * Completely decoupled from the filter and ADSR envelope.
   */
  updateExpression(time = this.ctx.currentTime) {
    if (!this.expressionGain) return;
    const exprNorm = Math.max(0, Math.min(127, this.cc11Expression)) / 127;
    // CC11 = 0 is completely silent, CC11 = 127 is full volume
    const exprGain = Math.pow(exprNorm, 1.4);
    const velGain = Math.pow(this.velocity, 1.1);
    const targetGain = exprGain * velGain * 0.8;

    this.expressionGain.gain.cancelScheduledValues(time);
    this.expressionGain.gain.setTargetAtTime(targetGain, time, 0.005);
  }

  setPitchBend(semitones) {
    this.pitchBend = semitones;
    this.updateFrequencies();
  }

  setCC(controller, value) {
    if (controller === 73) {
      this.cc73Cutoff = value;
      this.updateFilter();
    } else if (controller === 1) {
      this.cc1Resonance = value;
      this.updateFilter();
    } else if (controller === 11) {
      this.cc11Expression = value;
      this.updateExpression();
    }
  }

  setPressure(val) {
    this.pressure = val;
    if (this.filter && this.params && !this.isReleasing) {
      const extraCutoff = (val / 127) * 800;
      const base = this.calculateTargetCutoff(this.params.filterSustain || 0.3);
      const target = Math.min(20000, base + extraCutoff);
      this.filter.frequency.setTargetAtTime(target, this.ctx.currentTime, 0.01);
    }
  }

  updateParams(params) {
    this.params = params;
    if (this.osc1 && params.osc1Waveform) this.osc1.type = params.osc1Waveform;
    if (this.osc2 && params.osc2Waveform) this.osc2.type = params.osc2Waveform;

    if (this.osc1Gain && this.osc2Gain && params.osc2Mix !== undefined) {
      this.osc1Gain.gain.setTargetAtTime(1.0 - params.osc2Mix * 0.5, this.ctx.currentTime, 0.005);
      this.osc2Gain.gain.setTargetAtTime(params.osc2Mix, this.ctx.currentTime, 0.005);
    }

    this.updateFrequencies();
    this.updateFilter();
  }
}
