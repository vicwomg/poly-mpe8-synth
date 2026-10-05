/**
 * KarplusStrongProcessor - Extended Karplus-Strong (EKS) Physical Modeling Guitar Engine
 *
 * Implements digital waveguide physical modeling for vibrating electric guitar strings:
 * - Fractional delay line interpolation for precise tuning & seamless continuous MPE pitch bends.
 * - Pluck position comb filtering (beta parameter) modeling pick attack location along the string.
 * - Pluck excitation stage combining plectrum transient friction with velocity-shaped dynamic burst.
 * - Loop damping filter (1-pole lowpass) modeling frequency-dependent string energy dissipation.
 * - String stiffness all-pass dispersion filter modeling metal string inharmonicity / twang.
 * - Magnetic pickup simulation comb filter modeling bridge vs. neck pickup location.
 * - Organic string damping / palm mute behavior on note-off release.
 */

class KarplusStrongProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // 16384 samples buffer handles down to ~5 Hz at 48kHz
    this.bufferSize = 16384;
    this.bufferMask = this.bufferSize - 1;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;

    // String physical state
    this.isActive = false;
    this.isReleasing = false;
    this.targetFrequency = 220;
    this.currentFrequency = 220;
    this.velocity = 0.8;

    // Guitar parameters
    this.rawDecay = 0.9750;
    this.targetT60 = 8.0;      // Physical T60 sustain time in seconds (max 15.0s)
    this.damping = 0.70;       // String brightness / tone (higher = brighter, lower = mellow)
    this.pluckPos = 0.18;      // Pluck position along string (0.05 = near bridge, 0.5 = 12th fret)
    this.pickupPos = 0.12;     // Magnetic pickup position (0.08 = bridge, 0.3 = neck)
    this.stiffness = 0.08;     // Dispersion allpass factor (0.0 = pure harmonic, 0.2 = metallic twang)
    this.pickBite = 0.70;      // Pick transient snap and attack brightness

    // Loop filter states
    this.loopFiltY = 0;        // Loop damping IIR lowpass state
    this.apX = new Float32Array(4); // 4-stage stiffness allpass inputs
    this.apY = new Float32Array(4); // 4-stage stiffness allpass outputs

    // Output Guitar Tone circuit filter states (biquad lowpass)
    this.curToneCutoff = 6000;
    this.tfX1 = 0;
    this.tfX2 = 0;
    this.tfY1 = 0;
    this.tfY2 = 0;

    // Output DC blocker state
    this.dcX = 0;
    this.dcY = 0;

    // De-click state for pop-free voice stealing and re-plucking
    this.lastOutSample = 0;
    this.declickOffset = 0;
    this.declickSamples = 0;
    this.declickStep = 0;
    this.needsDeclick = false;

    // Smooth muting state
    this.isMuting = false;
    this.muteSamplesLeft = 0;
    this.muteStep = 0;
    this.muteGain = 1.0;

    // Excitation transient state
    this.exciteBuffer = null;
    this.exciteIndex = 0;

    // Pitch smoothing coefficient for zipper-free MPE pitch bend
    this.freqSmoothing = 0.008;

    // Listen for messages from SynthVoice
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  /**
   * Maps decay input (0.90 to 0.9998 or normalized) to physical string T60 sustain time in seconds.
   * Max sustain is 15s, providing predictable, musical sustain from 0.35s palm-mute chugs to 15s singing lead.
   */
  decayToT60(decayVal) {
    if (decayVal === undefined || decayVal === null) return 8.0;
    if (decayVal > 1.0) {
      return Math.max(0.35, Math.min(15.0, decayVal));
    }
    const u = Math.max(0, Math.min(1.0, (decayVal - 0.90) / (0.9998 - 0.90)));
    return 0.35 + 14.65 * Math.pow(u, 2.2);
  }

  /**
   * Computes exact per-circulation loop gain for a given fundamental frequency and target T60.
   * Ensures high and low notes sustain with identical musical duration across the entire fretboard.
   */
  computeLoopGain(freq, t60) {
    if (!isFinite(t60) || t60 >= 35.0) return 0.99992;
    const gain = Math.pow(0.001, 1.0 / (Math.max(10, freq) * t60));
    return Math.max(0.80, Math.min(0.99992, gain));
  }

  handleMessage(data) {
    if (!data) return;

    switch (data.type) {
      case 'pluck':
        this.triggerPluck(data);
        break;

      case 'setFrequency':
        if (data.frequency > 10 && data.frequency < 22000) {
          this.targetFrequency = data.frequency;
          if (data.immediate) {
            this.currentFrequency = this.targetFrequency;
          }
        }
        break;

      case 'release':
        this.isReleasing = true;
        if (typeof data.releaseTime === 'number' && data.releaseTime > 0) {
          this.releaseT60 = Math.max(0.05, Math.min(3.0, data.releaseTime));
        } else {
          this.releaseT60 = 0.9;
        }
        break;

      case 'setParams':
        if (data.decay !== undefined) {
          this.rawDecay = data.decay;
          this.targetT60 = this.decayToT60(data.decay);
        }
        if (data.damping !== undefined) {
          this.damping = Math.max(0.01, Math.min(0.99, data.damping));
        }
        if (data.pluckPos !== undefined) {
          this.pluckPos = Math.max(0.03, Math.min(0.5, data.pluckPos));
        }
        if (data.pickupPos !== undefined) {
          this.pickupPos = Math.max(0.05, Math.min(0.45, data.pickupPos));
        }
        if (data.stiffness !== undefined) {
          this.stiffness = Math.max(0.0, Math.min(0.70, data.stiffness));
        }
        if (data.pickBite !== undefined) {
          this.pickBite = Math.max(0.0, Math.min(1.0, data.pickBite));
        }
        break;

      case 'mute':
        if (this.isActive) {
          this.isMuting = true;
          this.muteSamplesLeft = 128; // ~2.67ms micro-fade
          this.muteStep = 1.0 / 128;
          this.muteGain = 1.0;
        } else {
          this.isActive = false;
          this.isReleasing = false;
          this.isMuting = false;
          this.exciteBuffer = null;
          this.exciteIndex = 0;
          this.buffer.fill(0);
          this.loopFiltY = 0;
          this.apX.fill(0);
          this.apY.fill(0);
          this.tfX1 = 0;
          this.tfX2 = 0;
          this.tfY1 = 0;
          this.tfY2 = 0;
          this.dcX = 0;
          this.dcY = 0;
          this.lastOutSample = 0;
        }
        break;
    }
  }

  triggerPluck(data) {
    const wasActive = this.isActive;
    this.isMuting = false;
    if (wasActive) {
      this.needsDeclick = true;
    }
    const freq = data.frequency || 220;
    this.targetFrequency = Math.max(10, Math.min(22000, freq));
    this.currentFrequency = this.targetFrequency;
    this.velocity = Math.max(0.02, Math.min(1.0, data.velocity || 0.8));
    this.isReleasing = false;

    if (data.decay !== undefined) {
      this.rawDecay = data.decay;
      this.targetT60 = this.decayToT60(data.decay);
    }
    if (data.damping !== undefined) this.damping = Math.max(0.01, Math.min(0.99, data.damping));
    if (data.pluckPos !== undefined) this.pluckPos = Math.max(0.03, Math.min(0.5, data.pluckPos));
    if (data.pickupPos !== undefined) this.pickupPos = Math.max(0.05, Math.min(0.45, data.pickupPos));
    if (data.stiffness !== undefined) this.stiffness = Math.max(0.0, Math.min(0.70, data.stiffness));
    if (data.pickBite !== undefined) this.pickBite = Math.max(0.0, Math.min(1.0, data.pickBite));

    // Clear previous string vibration so re-plucks start with fresh, consistent energy
    this.buffer.fill(0);
    this.writeIndex = 0;
    this.loopFiltY = 0;
    this.apX.fill(0);
    this.apY.fill(0);
    this.tfX1 = 0;
    this.tfX2 = 0;
    this.tfY1 = 0;
    this.tfY2 = 0;
    this.dcX = 0;
    this.dcY = 0;

    // Compute period length in samples
    const periodSamples = sampleRate / this.currentFrequency;
    const exciteLength = Math.max(16, Math.min(512, Math.floor(periodSamples)));

    // Generate physical excitation burst:
    // Combines a deterministic plectrum displacement impulse with subtle friction noise
    const rawBurst = new Float32Array(exciteLength);
    const bite = this.pickBite;
    
    // Excitation brightness is directly shaped by Tone (damping) and Pick Bite with zero random variance,
    // guaranteeing 100% identical spectral resonance on every pluck
    const exciteFilterCut = Math.min(0.96, Math.max(0.04, (0.06 + 0.90 * this.damping) * (0.4 + 0.6 * bite)));
    let exciteFilt = 0;

    for (let i = 0; i < exciteLength; i++) {
      const t = i / exciteLength;
      // Exponential decay envelope for the initial pick contact
      const env = Math.exp(-t * 9.0);
      
      // 100% deterministic physical pick transient (zero pseudo-random variance):
      // Combines asymmetric plectrum displacement impulse with metallic wire-wrap friction partials
      const pluckPulse = Math.sin(Math.PI * t) * Math.sin(2 * Math.PI * t);
      const scrape1 = Math.sin(2 * Math.PI * 3420 * (i / sampleRate)) * 0.22 * bite * env;
      const scrape2 = Math.sin(2 * Math.PI * 5180 * (i / sampleRate)) * 0.14 * bite * Math.exp(-t * 16.0);
      const scrape3 = Math.sin(2 * Math.PI * 7910 * (i / sampleRate)) * 0.08 * bite * Math.exp(-t * 22.0);
      const combined = pluckPulse + scrape1 + scrape2 + scrape3;

      // 1-pole lowpass on the burst to model plectrum softness
      exciteFilt += exciteFilterCut * (combined - exciteFilt);
      rawBurst[i] = exciteFilt;
    }

    // Apply Pluck Position Comb Filter: H_pluck(z) = 1 - z^(-pluckDelay)
    // beta = pluckPos (fraction of string length from bridge)
    const pluckDelay = Math.max(1, Math.min(exciteLength - 1, Math.round(this.pluckPos * periodSamples)));
    const combExcite = new Float32Array(exciteLength);
    let sumSq = 0;
    for (let i = 0; i < exciteLength; i++) {
      const delayed = (i >= pluckDelay) ? rawBurst[i - pluckDelay] : 0;
      const val = rawBurst[i] - delayed;
      combExcite[i] = val;
      sumSq += val * val;
    }

    // Calibrate & normalize excitation energy:
    // Staggered pickup pole & string radiation compensation balances low strings and high strings
    // so every string speaks with uniform perceived volume across the fretboard
    const fNorm = Math.max(60, this.currentFrequency);
    const stringComp = 0.85 + 0.35 * Math.pow(fNorm / 196, 0.45);
    const currentRms = Math.sqrt(sumSq / exciteLength);
    const targetRms = 0.38 * stringComp;
    const scale = targetRms / Math.max(0.0001, currentRms);
    for (let i = 0; i < exciteLength; i++) {
      combExcite[i] *= scale;
    }

    this.exciteBuffer = combExcite;
    this.exciteIndex = 0;
    this.isActive = true;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outChannel = output[0];
    const numSamples = outChannel.length;

    if (!this.isActive && !this.isMuting) {
      outChannel.fill(0);
      this.lastOutSample = 0;
      return true;
    }

    const sRate = sampleRate;
    const mask = this.bufferMask;
    const buf = this.buffer;
    let wIdx = this.writeIndex;
    let curFreq = this.currentFrequency;
    const targetFreq = this.targetFrequency;
    const freqSmooth = this.freqSmoothing;

    const stiffnessA = this.stiffness;
    const puPos = this.pickupPos;

    // 1. String Stiffness / Dispersion 4-stage Allpass Parameters:
    // Each stage: H(z) = (-a + z^-1) / (1 - a z^-1)
    // Higher stiffness = larger a = higher partials travel faster & bend sharp (+twang).
    const aTarget = Math.max(0.0, Math.min(0.80, stiffnessA * 1.15));
    const periodSamples = sRate / curFreq;
    const maxDelayAllowed = Math.max(4.0, periodSamples - 8.0);
    const rawApDelay = 4.0 * ((1.0 + aTarget) / (1.0 - aTarget));
    const clampedApDelay = Math.min(rawApDelay, maxDelayAllowed);
    const apRatio = clampedApDelay / 4.0;
    const a = Math.max(0.0, Math.min(0.80, (apRatio - 1.0) / (apRatio + 1.0)));
    const apDelay = 4.0 * ((1.0 + a) / (1.0 - a));

    // 2. Loop Damping IIR Filter: y[n] = (1 - g)*x[n] + g*y[n-1]
    // Zero DC loss, DC gain = 1.0, exact DC group delay = g / (1 - g).
    // Low tone (damping) = higher g (rapid loss of high partials, dark jazz/nylon warmth).
    // High tone = lower g (singing sustain of upper harmonics, bright acoustic bite).
    const gBase = Math.max(0.02, Math.min(0.78, (1.0 - this.damping) * 0.78));
    const fNorm = Math.max(60, curFreq) / 220;
    const g = Math.max(0.01, Math.min(0.75, gBase / Math.pow(fNorm, 0.45)));
    const iirDelay = g / (1.0 - g);

    // Total phase delay correction for fundamental frequency
    const phaseCorrection = apDelay + iirDelay;

    // Active sustain decay time
    const activeT60 = (this.isReleasing && isFinite(this.targetT60))
      ? Math.min(this.targetT60, this.releaseT60 || 0.9)
      : this.targetT60;

    // Compensate loop gain for IIR damping filter attenuation and fractional interpolation loss
    const omega = 2 * Math.PI * Math.min(curFreq, 12000) / sRate;
    const denIIR = Math.sqrt(Math.pow(1 - g * Math.cos(omega), 2) + Math.pow(g * Math.sin(omega), 2));
    const h_iir = (1 - g) / denIIR;
    const delayEst = Math.max(4.0, (sRate / curFreq) - phaseCorrection);
    const fracEst = delayEst - Math.floor(delayEst);
    const h_interp = Math.sqrt(Math.max(0.01, 1.0 - 4.0 * fracEst * (1.0 - fracEst) * Math.pow(Math.sin(omega * 0.5), 2)));
    const h_total = Math.max(0.2, h_iir * h_interp);

    const rawLoopGain = Math.pow(0.001, 1.0 / (Math.max(10, curFreq) * activeT60));
    const loopGain = Math.max(0.80, Math.min(1.03, (rawLoopGain * 0.99995) / h_total));

    // 3. Real-Time Output Tone Pot Circuit (2-pole Biquad Lowpass):
    // Smoothly tracks this.damping in real-time (400 Hz at 0% to 20,000 Hz at 100%)
    const targetToneCutoff = 400 * Math.pow(50, this.damping);
    this.curToneCutoff += (targetToneCutoff - this.curToneCutoff) * 0.15;
    const toneW = 2 * Math.PI * Math.min(22000, this.curToneCutoff) / sRate;
    const alphaQ = Math.sin(toneW) * 0.70710678; // Butterworth Q = 0.7071
    const cosW = Math.cos(toneW);
    const invA0 = 1.0 / (1 + alphaQ);
    const toneMakeup = 1.0 + 0.10 * (1.0 - this.damping);
    const tb0 = (1 - cosW) * 0.5 * invA0 * toneMakeup;
    const tb1 = (1 - cosW) * invA0 * toneMakeup;
    const tb2 = (1 - cosW) * 0.5 * invA0 * toneMakeup;
    const ta1 = -2 * cosW * invA0;
    const ta2 = (1 - alphaQ) * invA0;

    let iirY = this.loopFiltY;
    const apX = this.apX;
    const apY = this.apY;
    let tfX1 = this.tfX1;
    let tfX2 = this.tfX2;
    let tfY1 = this.tfY1;
    let tfY2 = this.tfY2;
    let dcX = this.dcX;
    let dcY = this.dcY;

    for (let n = 0; n < numSamples; n++) {
      // Smooth frequency transition (continuous MPE pitch bend)
      curFreq += (targetFreq - curFreq) * freqSmooth;

      // Calculate total fractional delay length
      const delay = Math.max(4.0, (sRate / curFreq) - phaseCorrection);
      const intDelay = Math.floor(delay);
      const frac = delay - intDelay;

      // Read from delay line with fractional linear interpolation
      const readIdx1 = (wIdx - intDelay + this.bufferSize) & mask;
      const readIdx2 = (readIdx1 - 1 + this.bufferSize) & mask;
      const delayedSample = buf[readIdx1] * (1 - frac) + buf[readIdx2] * frac;

      // 1. Loop Damping Filter: y[n] = (1 - g)*x[n] + g*y[n-1]
      // Zero DC loss, frequency-dependent attenuation of higher partials
      iirY = (1 - g) * delayedSample + g * iirY;

      // 2. String Stiffness / Dispersion Filter (4-stage Allpass Cascade)
      // Shifts phase of higher partials slightly sharp to model wire inharmonicity
      let apSig = iirY;
      for (let s = 0; s < 4; s++) {
        const y = -a * apSig + apX[s] + a * apY[s];
        apX[s] = apSig;
        apY[s] = y;
        apSig = y;
      }

      // 3. Feedback Loop Multiplier (string sustain/decay)
      const loopFeedback = apSig * loopGain;

      // 4. Inject additive excitation into loop
      let x_n = 0;
      if (this.exciteBuffer && this.exciteIndex < this.exciteBuffer.length) {
        x_n = this.exciteBuffer[this.exciteIndex++];
        if (this.exciteIndex >= this.exciteBuffer.length) {
          this.exciteBuffer = null;
        }
      }

      buf[wIdx] = loopFeedback + x_n;

      // 5. Magnetic Pickup Simulation (Comb Filter)
      // Models pickup distance from the bridge: H_pu(z) = y[n] - 0.88 * y[n - puDelay]
      const puDelaySamples = Math.max(1, Math.min(intDelay - 1, Math.round(puPos * delay)));
      const puReadIdx = (wIdx - puDelaySamples + this.bufferSize) & mask;
      const pickupSignal = buf[wIdx] - 0.88 * buf[puReadIdx];

      // 6. Guitar Output Tone Pot Circuit (2-pole lowpass)
      const toneSig = tb0 * pickupSignal + tb1 * tfX1 + tb2 * tfX2 - ta1 * tfY1 - ta2 * tfY2;
      tfX2 = tfX1; tfX1 = pickupSignal;
      tfY2 = tfY1; tfY1 = toneSig;

      // 7. DC Blocker on output stage only (does NOT attenuate the delay loop)
      const outSample = toneSig - dcX + 0.995 * dcY;
      dcX = toneSig;
      dcY = outSample;

      let finalOut = outSample;

      // Anti-pop de-clicking on voice stealing/re-plucking:
      // Bridges any step discontinuity between the old vibrating string and the new pluck excitation over 64 samples
      if (this.needsDeclick) {
        this.needsDeclick = false;
        const diff = this.lastOutSample - finalOut;
        if (Math.abs(diff) > 0.0001) {
          this.declickOffset = diff;
          this.declickSamples = 64; // ~1.33ms at 48kHz
          this.declickStep = diff / 64;
        }
      }

      if (this.declickSamples > 0) {
        finalOut += this.declickOffset;
        this.declickOffset -= this.declickStep;
        this.declickSamples--;
      }

      // Smooth muting ramp
      if (this.isMuting) {
        finalOut *= this.muteGain;
        this.muteGain -= this.muteStep;
        this.muteSamplesLeft--;
        if (this.muteSamplesLeft <= 0) {
          this.isMuting = false;
          this.isActive = false;
          this.buffer.fill(0);
          this.loopFiltY = 0;
          this.apX.fill(0);
          this.apY.fill(0);
          this.tfX1 = 0;
          this.tfX2 = 0;
          this.tfY1 = 0;
          this.tfY2 = 0;
          this.dcX = 0;
          this.dcY = 0;
          finalOut = 0;
        }
      }

      outChannel[n] = finalOut;
      this.lastOutSample = finalOut;

      wIdx = (wIdx + 1) & mask;
    }

    this.writeIndex = wIdx;
    this.currentFrequency = curFreq;
    this.loopFiltY = iirY;
    this.tfX1 = tfX1;
    this.tfX2 = tfX2;
    this.tfY1 = tfY1;
    this.tfY2 = tfY2;
    this.dcX = dcX;
    this.dcY = dcY;

    return true;
  }
}

registerProcessor('karplus-strong-processor', KarplusStrongProcessor);
