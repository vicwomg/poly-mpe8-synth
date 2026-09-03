/**
 * Presets library for the POLY-MPE Synthesizer.
 */
export const PRESETS = [
  {
    name: 'Clean Pedal Steel Guitar',
    params: {
      osc1Waveform: 'triangle',
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: 0,

      osc2Waveform: 'sawtooth',
      osc2Octave: 0,
      osc2Semi: 0,
      osc2Fine: 2,
      osc2Mix: 0.28,

      filterCutoff: 3600,
      filterResonance: 1.6,
      filterEnvAmount: 0.28,
      filterKeyTracking: 0.75,
      filterAttack: 0.005,
      filterDecay: 0.35,
      filterSustain: 0.7,
      filterRelease: 0.4,

      ampAttack: 0.008,
      ampDecay: 0.8,
      ampSustain: 0.75,
      ampRelease: 0.45,

      lfoWaveform: 'sine',
      lfoRate: 4.8,
      lfoDepth: 0.0,
      lfoTarget: 'none',

      distortionEnabled: false,
      distortionDrive: 10,
      distortionTone: 4000,
      distortionMix: 0.0,

      delayEnabled: true,
      delayTime: 0.22,
      delayFeedback: 0.35,
      delayMix: 0.22,

      reverbEnabled: true,
      reverbTime: 2.2,
      reverbDamp: 4000,
      reverbMix: 0.28,

      masterVolume: 0.8,
      mpePitchBendRange: 48
    }
  },
  {
    name: 'MPE Dream Pad',
    params: {
      osc1Waveform: 'sawtooth',
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: -4,

      osc2Waveform: 'sawtooth',
      osc2Octave: 0,
      osc2Semi: 0,
      osc2Fine: 8,
      osc2Mix: 0.55,

      filterCutoff: 1800,
      filterResonance: 2.2,
      filterEnvAmount: 0.45,
      filterKeyTracking: 0.5,
      filterAttack: 0.35,
      filterDecay: 0.8,
      filterSustain: 0.6,
      filterRelease: 0.9,

      ampAttack: 0.25,
      ampDecay: 0.5,
      ampSustain: 0.8,
      ampRelease: 0.9,

      lfoWaveform: 'sine',
      lfoRate: 2.0,
      lfoDepth: 0.15,
      lfoTarget: 'filter',

      distortionEnabled: false,
      distortionDrive: 15,
      distortionTone: 3000,
      distortionMix: 0.0,

      delayEnabled: true,
      delayTime: 0.32,
      delayFeedback: 0.5,
      delayMix: 0.35,

      reverbEnabled: true,
      reverbTime: 3.2,
      reverbDamp: 3000,
      reverbMix: 0.4,

      masterVolume: 0.75,
      mpePitchBendRange: 48
    }
  },
  {
    name: 'Ambient Shoegaze Shimmer',
    params: {
      osc1Waveform: 'sawtooth',
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: -5,

      osc2Waveform: 'square',
      osc2Octave: 1,
      osc2Semi: 0,
      osc2Fine: 7,
      osc2Mix: 0.45,

      filterCutoff: 2200,
      filterResonance: 2.4,
      filterEnvAmount: 0.4,
      filterKeyTracking: 0.6,
      filterAttack: 0.45,
      filterDecay: 1.2,
      filterSustain: 0.75,
      filterRelease: 1.4,

      ampAttack: 0.4,
      ampDecay: 0.8,
      ampSustain: 0.85,
      ampRelease: 1.5,

      lfoWaveform: 'sine',
      lfoRate: 0.8,
      lfoDepth: 0.25,
      lfoTarget: 'filter',

      distortionEnabled: false,
      distortionDrive: 20,
      distortionTone: 3500,
      distortionMix: 0.0,

      delayEnabled: true,
      delayTime: 0.42,
      delayFeedback: 0.65,
      delayMix: 0.45,

      reverbEnabled: true,
      reverbTime: 4.2,
      reverbDamp: 3200,
      reverbMix: 0.5,

      masterVolume: 0.72,
      mpePitchBendRange: 48
    }
  },
  {
    name: 'Vaporwave Electric Piano',
    params: {
      osc1Waveform: 'sine',
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: 0,

      osc2Waveform: 'triangle',
      osc2Octave: 1,
      osc2Semi: 0,
      osc2Fine: 3,
      osc2Mix: 0.35,

      filterCutoff: 2600,
      filterResonance: 1.4,
      filterEnvAmount: 0.55,
      filterKeyTracking: 0.8,
      filterAttack: 0.005,
      filterDecay: 0.55,
      filterSustain: 0.35,
      filterRelease: 0.4,

      ampAttack: 0.008,
      ampDecay: 0.7,
      ampSustain: 0.45,
      ampRelease: 0.35,

      lfoWaveform: 'sine',
      lfoRate: 4.2,
      lfoDepth: 0.0,
      lfoTarget: 'pitch',

      distortionEnabled: false,
      distortionDrive: 12,
      distortionTone: 3500,
      distortionMix: 0.0,

      delayEnabled: true,
      delayTime: 0.24,
      delayFeedback: 0.35,
      delayMix: 0.25,

      reverbEnabled: true,
      reverbTime: 2.0,
      reverbDamp: 3500,
      reverbMix: 0.28,

      masterVolume: 0.78,
      mpePitchBendRange: 48
    }
  },
  {
    name: 'Retro Funk Clavinet',
    params: {
      osc1Waveform: 'square',
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: 0,

      osc2Waveform: 'square',
      osc2Octave: 0,
      osc2Semi: 0,
      osc2Fine: 5,
      osc2Mix: 0.5,

      filterCutoff: 1100,
      filterResonance: 4.2,
      filterEnvAmount: 0.75,
      filterKeyTracking: 0.65,
      filterAttack: 0.005,
      filterDecay: 0.16,
      filterSustain: 0.15,
      filterRelease: 0.15,

      ampAttack: 0.005,
      ampDecay: 0.25,
      ampSustain: 0.5,
      ampRelease: 0.15,

      lfoWaveform: 'sine',
      lfoRate: 5.0,
      lfoDepth: 0.0,
      lfoTarget: 'none',

      distortionEnabled: true,
      distortionDrive: 18,
      distortionTone: 5500,
      distortionMix: 0.3,

      delayEnabled: false,
      delayTime: 0.16,
      delayFeedback: 0.2,
      delayMix: 0.15,

      reverbEnabled: true,
      reverbTime: 1.2,
      reverbDamp: 4500,
      reverbMix: 0.18,

      masterVolume: 0.8,
      mpePitchBendRange: 48
    }
  },
  {
    name: 'Cinematic Bowed Strings',
    params: {
      osc1Waveform: 'sawtooth',
      osc1Octave: -1,
      osc1Semi: 0,
      osc1Fine: -4,

      osc2Waveform: 'sawtooth',
      osc2Octave: 0,
      osc2Semi: 0,
      osc2Fine: 6,
      osc2Mix: 0.5,

      filterCutoff: 1600,
      filterResonance: 1.8,
      filterEnvAmount: 0.35,
      filterKeyTracking: 0.6,
      filterAttack: 0.2,
      filterDecay: 0.5,
      filterSustain: 0.8,
      filterRelease: 0.75,

      ampAttack: 0.15,
      ampDecay: 0.4,
      ampSustain: 0.85,
      ampRelease: 0.7,

      lfoWaveform: 'sine',
      lfoRate: 3.8,
      lfoDepth: 0.08,
      lfoTarget: 'pitch',

      distortionEnabled: false,
      distortionDrive: 15,
      distortionTone: 3000,
      distortionMix: 0.0,

      delayEnabled: true,
      delayTime: 0.35,
      delayFeedback: 0.45,
      delayMix: 0.3,

      reverbEnabled: true,
      reverbTime: 3.8,
      reverbDamp: 2800,
      reverbMix: 0.42,

      masterVolume: 0.75,
      mpePitchBendRange: 48
    }
  },
  {
    name: 'Acid Bass Line',
    params: {
      osc1Waveform: 'sawtooth',
      osc1Octave: -1,
      osc1Semi: 0,
      osc1Fine: 0,

      osc2Waveform: 'square',
      osc2Octave: -1,
      osc2Semi: 0,
      osc2Fine: 0,
      osc2Mix: 0.4,

      filterCutoff: 650,
      filterResonance: 6.5,
      filterEnvAmount: 0.85,
      filterKeyTracking: 0.2,
      filterAttack: 0.01,
      filterDecay: 0.28,
      filterSustain: 0.1,
      filterRelease: 0.15,

      ampAttack: 0.01,
      ampDecay: 0.22,
      ampSustain: 0.4,
      ampRelease: 0.15,

      lfoWaveform: 'sine',
      lfoRate: 5.0,
      lfoDepth: 0.0,
      lfoTarget: 'none',

      distortionEnabled: true,
      distortionDrive: 35,
      distortionTone: 4500,
      distortionMix: 0.65,

      delayEnabled: true,
      delayTime: 0.18,
      delayFeedback: 0.25,
      delayMix: 0.15,

      reverbEnabled: false,
      reverbTime: 1.0,
      reverbDamp: 2500,
      reverbMix: 0.1,

      masterVolume: 0.8,
      mpePitchBendRange: 48
    }
  },
  {
    name: 'Expressive Solo Lead',
    params: {
      osc1Waveform: 'sawtooth',
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: 0,

      osc2Waveform: 'square',
      osc2Octave: 0,
      osc2Semi: 7, // 5th interval for fat lead
      osc2Fine: 5,
      osc2Mix: 0.45,

      filterCutoff: 3200,
      filterResonance: 3.5,
      filterEnvAmount: 0.4,
      filterKeyTracking: 0.7,
      filterAttack: 0.02,
      filterDecay: 0.3,
      filterSustain: 0.7,
      filterRelease: 0.3,

      ampAttack: 0.02,
      ampDecay: 0.2,
      ampSustain: 0.85,
      ampRelease: 0.35,

      lfoWaveform: 'sine',
      lfoRate: 4.5,
      lfoDepth: 0.12,
      lfoTarget: 'pitch',

      distortionEnabled: true,
      distortionDrive: 25,
      distortionTone: 4200,
      distortionMix: 0.45,

      delayEnabled: true,
      delayTime: 0.28,
      delayFeedback: 0.45,
      delayMix: 0.3,

      reverbEnabled: true,
      reverbTime: 2.4,
      reverbDamp: 3500,
      reverbMix: 0.32,

      masterVolume: 0.75,
      mpePitchBendRange: 48
    }
  },
  {
    name: '80s Poly Brass',
    params: {
      osc1Waveform: 'sawtooth',
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: -6,

      osc2Waveform: 'sawtooth',
      osc2Octave: 0,
      osc2Semi: 0,
      osc2Fine: 8,
      osc2Mix: 0.5,

      filterCutoff: 1200,
      filterResonance: 1.8,
      filterEnvAmount: 0.7,
      filterKeyTracking: 0.5,
      filterAttack: 0.08,
      filterDecay: 0.4,
      filterSustain: 0.55,
      filterRelease: 0.4,

      ampAttack: 0.06,
      ampDecay: 0.3,
      ampSustain: 0.75,
      ampRelease: 0.4,

      lfoWaveform: 'sine',
      lfoRate: 1.5,
      lfoDepth: 0.0,
      lfoTarget: 'none',

      distortionEnabled: false,
      distortionDrive: 10,
      distortionTone: 5000,
      distortionMix: 0.0,

      delayEnabled: true,
      delayTime: 0.22,
      delayFeedback: 0.28,
      delayMix: 0.2,

      reverbEnabled: true,
      reverbTime: 2.5,
      reverbDamp: 3800,
      reverbMix: 0.25,

      masterVolume: 0.75,
      mpePitchBendRange: 48
    }
  },
  {
    name: 'Cosmic Pluck',
    params: {
      osc1Waveform: 'triangle',
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: 0,

      osc2Waveform: 'sawtooth',
      osc2Octave: 1, // Octave above
      osc2Semi: 0,
      osc2Fine: 4,
      osc2Mix: 0.3,

      filterCutoff: 800,
      filterResonance: 4.0,
      filterEnvAmount: 0.8,
      filterKeyTracking: 0.75,
      filterAttack: 0.01,
      filterDecay: 0.25,
      filterSustain: 0.05,
      filterRelease: 0.25,

      ampAttack: 0.01,
      ampDecay: 0.3,
      ampSustain: 0.1,
      ampRelease: 0.3,

      lfoWaveform: 'sine',
      lfoRate: 3.0,
      lfoDepth: 0.0,
      lfoTarget: 'none',

      distortionEnabled: false,
      distortionDrive: 15,
      distortionTone: 4000,
      distortionMix: 0.0,

      delayEnabled: true,
      delayTime: 0.36,
      delayFeedback: 0.55,
      delayMix: 0.4,

      reverbEnabled: true,
      reverbTime: 3.0,
      reverbDamp: 3500,
      reverbMix: 0.35,

      masterVolume: 0.75,
      mpePitchBendRange: 48
    }
  },
  {
    name: 'Init Dual Saw',
    params: {
      osc1Waveform: 'sawtooth',
      osc1Octave: 0,
      osc1Semi: 0,
      osc1Fine: 0,

      osc2Waveform: 'sawtooth',
      osc2Octave: 0,
      osc2Semi: 0,
      osc2Fine: 7,
      osc2Mix: 0.5,

      filterCutoff: 3000,
      filterResonance: 1.0,
      filterEnvAmount: 0.3,
      filterKeyTracking: 0.5,
      filterAttack: 0.02,
      filterDecay: 0.2,
      filterSustain: 0.6,
      filterRelease: 0.3,

      ampAttack: 0.02,
      ampDecay: 0.2,
      ampSustain: 0.8,
      ampRelease: 0.3,

      lfoWaveform: 'sine',
      lfoRate: 3.5,
      lfoDepth: 0.0,
      lfoTarget: 'none',

      distortionEnabled: false,
      distortionDrive: 20,
      distortionTone: 4000,
      distortionMix: 0.5,

      delayEnabled: false,
      delayTime: 0.28,
      delayFeedback: 0.4,
      delayMix: 0.25,

      reverbEnabled: false,
      reverbTime: 2.2,
      reverbDamp: 3500,
      reverbMix: 0.3,

      masterVolume: 0.75,
      mpePitchBendRange: 48
    }
  }
];
