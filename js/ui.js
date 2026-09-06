import { SynthEngine } from './synth-engine.js';
import { MidiHandler } from './midi-handler.js';
import { Visualizer } from './visualizer.js';
import { PresetManager } from './preset-manager.js';

class SynthUI {
  constructor() {
    this.synth = new SynthEngine();
    this.midi = new MidiHandler(this.synth);
    this.visualizer = null;
    this.baseOctave = 4; // C4
    this.activeMouseNotes = new Map();
    this.activeKeyNotes = new Map();
    this.midiLogEntries = [];
    this.presetManager = new PresetManager();
    this.currentPresetId = null;
    this.isMidiMonitorEnabled = false; // Disabled by default for maximum performance

    this.synth.ui = this;
    this.synth.hasSmoothCutoff = true;
  }

  async init() {
    // Dynamic Notch / Safe Area Orientation Tracking
    const updateNotchOrientation = () => {
      let isSecondary = false;
      if (window.screen?.orientation) {
        isSecondary = window.screen.orientation.type === 'landscape-secondary';
      } else if (typeof window.orientation !== 'undefined') {
        isSecondary = window.orientation === -90;
      }
      document.documentElement.dataset.notchSide = isSecondary ? 'right' : 'left';
    };
    updateNotchOrientation();
    window.addEventListener('orientationchange', updateNotchOrientation);
    window.screen?.orientation?.addEventListener?.('change', updateNotchOrientation);

    // 1. Audio Start / Resume
    const btnPower = document.getElementById('btn-audio-power');
    const startAudioEngine = async () => {
      if (this.synth.isAudioStarted) return;
      await this.synth.initAudio();
      document.body.classList.add('audio-started');

      if (!this.visualizer) {
        this.visualizer = new Visualizer(this.synth, 'oscilloscope-canvas', 'filter-canvas');
        this.visualizer.start();
        this.setupVisualizerControls();
      }

      // Request MIDI access if not yet granted
      if (!this.midi.midiAccess) {
        await this.midi.requestAccess();
      }

      // Keep screen awake while audio is running on mobile/desktop (web mode only)
      if (this.keepScreenAwake && (!window.Capacitor || !window.Capacitor.isNativePlatform())) {
        await this.requestWakeLock();
      }
    };

    btnPower?.addEventListener('click', startAudioEngine);

    // Native Capacitor App Auto-Startup:
    // In native iOS and Android WebViews, mediaPlaybackRequiresUserGesture is disabled.
    // Automatically start audio and connect MIDI on app launch.
    if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform()) {
      document.body.classList.add('capacitor-native');
      setTimeout(() => {
        startAudioEngine().catch(err => console.warn('Native auto-audio start:', err));
      }, 50);
    }

    // 1b. Buffer Size & Polyphony Controls
    const bufferSelect = document.getElementById('buffer-select');
    const bufferStat = document.getElementById('buffer-stat');
    const polySelect = document.getElementById('poly-select');
    const maxVoiceEl = document.getElementById('voice-count-max');

    if (bufferSelect) {
      bufferSelect.value = this.synth.bufferMode;
      bufferSelect.addEventListener('change', async (e) => {
        await this.synth.reconfigureAudio(e.target.value, null);
        if (this.visualizer && this.synth.isAudioStarted) {
          this.visualizer.synth = this.synth;
        }
      });
    }

    if (polySelect) {
      polySelect.value = this.synth.voiceCount.toString();
      polySelect.addEventListener('change', async (e) => {
        const count = parseInt(e.target.value, 10);
        await this.synth.reconfigureAudio(null, count);
        if (maxVoiceEl) maxVoiceEl.textContent = `/${count}`;
      });
    }

    const mpeBendSelect = document.getElementById('mpe-bend-select');
    if (mpeBendSelect) {
      mpeBendSelect.value = (this.synth.params.mpePitchBendRange || 48).toString();
      mpeBendSelect.addEventListener('change', (e) => {
        const range = parseInt(e.target.value, 10);
        this.synth.updateParam('mpePitchBendRange', range);
      });
    }

    const cc1TargetSelect = document.getElementById('cc1-target-select');
    if (cc1TargetSelect) {
      cc1TargetSelect.value = this.synth.params.cc1Target || 'resonance';
      cc1TargetSelect.addEventListener('change', (e) => {
        const target = e.target.value;
        this.synth.updateParam('cc1Target', target);
        if (target === 'lforate') {
          for (const voice of this.synth.voices) {
            voice.cc1Resonance = 0;
            voice.updateFilter();
          }
        } else {
          const baseRate = this.synth.params.lfoRate || 3.5;
          this.updateSliderUI('lfoRate', baseRate, `${baseRate} Hz`);
        }
        this.visualizer?.markFilterDirty();
        this.updateSharedModulationBadges();
      });
    }

    const volumeCcSelect = document.getElementById('volume-cc-select');
    if (volumeCcSelect) {
      volumeCcSelect.value = String(this.synth.params.volumeCC || 11);
      volumeCcSelect.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        this.synth.updateParam('volumeCC', val);
      });
    }

    const pressureTargetSelect = document.getElementById('pressure-target-select');
    if (pressureTargetSelect) {
      pressureTargetSelect.value = this.synth.params.mpePressureTarget || 'both';
      pressureTargetSelect.addEventListener('change', (e) => {
        this.synth.updateParam('mpePressureTarget', e.target.value);
        this.updateSharedModulationBadges();
        this.saveActiveSession();
      });
    }

    const timbreTargetSelect = document.getElementById('mpe-timbre-target-select');
    if (timbreTargetSelect) {
      timbreTargetSelect.value = this.synth.params.mpeTimbreTarget || 'cutoff';
      timbreTargetSelect.addEventListener('change', (e) => {
        const target = e.target.value;
        this.synth.updateParam('mpeTimbreTarget', target);
        if (target === 'resonance') {
          this.visualizer?.markFilterDirty();
        }
        this.updateSharedModulationBadges();
        this.saveActiveSession();
      });
    }

    this.synth.onBufferStatChange = (ms) => {
      if (bufferStat) bufferStat.textContent = `${ms} ms`;
    };

    // 2. Settings Modal & Info Modal UI
    const midiSelect = document.getElementById('midi-input-select');
    const alertBanner = document.getElementById('midi-alert-banner');
    const alertText = document.getElementById('midi-alert-text');
    const btnBannerAction = document.getElementById('btn-banner-action');
    const btnBannerClose = document.getElementById('btn-banner-close');

    const settingsModal = document.getElementById('settings-modal');
    const btnSettings = document.getElementById('btn-settings-modal');
    const btnCloseSettings = document.getElementById('btn-close-settings');

    const infoModal = document.getElementById('synth-info-modal');
    const btnInfo = document.getElementById('btn-synth-info');
    const btnCloseInfo = document.getElementById('btn-close-info');

    const btnMidiScan = document.getElementById('btn-midi-scan');

    // Settings Modal controls
    // Settings Modal controls
    if (btnSettings) {
      btnSettings.addEventListener('click', () => {
        settingsModal.style.display = 'flex';
        syncMidiSteelUI();
        if (typeof syncPreferredMidiUI === 'function') syncPreferredMidiUI();
      });
    }
    if (btnCloseSettings) btnCloseSettings.addEventListener('click', () => settingsModal.style.display = 'none');
    if (settingsModal) {
      settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) settingsModal.style.display = 'none';
      });
    }

    // Info Modal controls (Opened via About link in Settings)
    const btnOpenAbout = document.getElementById('btn-open-about');
    if (btnOpenAbout) {
      btnOpenAbout.addEventListener('click', () => {
        if (settingsModal) settingsModal.style.display = 'none';
        if (infoModal) infoModal.style.display = 'flex';
      });
    }
    if (btnInfo) btnInfo.addEventListener('click', () => infoModal.style.display = 'flex');
    if (btnCloseInfo) btnCloseInfo.addEventListener('click', () => infoModal.style.display = 'none');
    if (infoModal) {
      infoModal.addEventListener('click', (e) => {
        if (e.target === infoModal) infoModal.style.display = 'none';
      });
    }

    // Banner action opens Settings modal
    if (btnBannerClose) btnBannerClose.addEventListener('click', () => alertBanner.style.display = 'none');
    if (btnBannerAction) btnBannerAction.addEventListener('click', () => settingsModal.style.display = 'flex');

    // MIDISteel Modal controls
    const btnMidiSteel = document.getElementById('btn-midisteel');
    const midisteelSettingsRow = document.getElementById('midisteel-settings-row');
    const btnOpenMidiSteelSettings = document.getElementById('btn-open-midisteel-settings');
    const midisteelModal = document.getElementById('midisteel-modal');
    const btnMidiSteelClose = document.getElementById('btn-midisteel-close');
    const midisteelIframe = document.getElementById('midisteel-iframe');

    const syncMidiSteelUI = () => {
      const hasMidiSteel = this.midi.isMidiSteelConnected();
      if (btnMidiSteel) btnMidiSteel.style.display = hasMidiSteel ? 'inline-flex' : 'none';
      if (midisteelSettingsRow) midisteelSettingsRow.style.display = hasMidiSteel ? 'flex' : 'none';
    };

    this.midi.onMidiSteelDetected = () => {
      syncMidiSteelUI();
    };

    const openMidiSteelModal = () => {
      if (settingsModal) settingsModal.style.display = 'none';
      if (midisteelModal) {
        midisteelModal.style.display = 'flex';
        if (midisteelIframe && (!midisteelIframe.src || midisteelIframe.src === 'about:blank' || midisteelIframe.src.endsWith('about:blank'))) {
          midisteelIframe.src = 'midisteel_settings.html';
        }
      }
    };

    const closeMidiSteelModal = () => {
      if (midisteelModal) midisteelModal.style.display = 'none';
    };

    if (btnMidiSteel) btnMidiSteel.addEventListener('click', openMidiSteelModal);
    if (btnOpenMidiSteelSettings) btnOpenMidiSteelSettings.addEventListener('click', openMidiSteelModal);
    if (btnMidiSteelClose) btnMidiSteelClose.addEventListener('click', closeMidiSteelModal);
    if (midisteelModal) {
      midisteelModal.addEventListener('click', (e) => {
        if (e.target === midisteelModal) closeMidiSteelModal();
      });
    }
    // Ensure WebAudio is resumed on any touch gesture on iOS
    ['touchstart', 'touchend', 'pointerdown', 'click'].forEach(evtType => {
      document.addEventListener(evtType, () => {
        if (this.synth.ctx && this.synth.ctx.state === 'suspended') {
          this.synth.ctx.resume().catch(() => {});
        }
      }, { passive: true });
    });

    // Scan button inside Settings modal
    if (btnMidiScan) {
      btnMidiScan.addEventListener('click', async () => {
        btnMidiScan.textContent = 'SCANNING...';
        await this.midi.requestAccess();
        syncMidiSteelUI();
        setTimeout(() => {
          btnMidiScan.textContent = 'SCAN';
        }, 600);
      });
    }

    const prefNameEl = document.getElementById('preferred-midi-name');
    const prefBadgeEl = document.getElementById('preferred-midi-badge');
    const btnSetPref = document.getElementById('btn-set-preferred-midi');
    const btnClearPref = document.getElementById('btn-clear-preferred-midi');

    const syncPreferredMidiUI = () => {
      const pref = this.midi.getPreferredDevice();
      if (!prefNameEl) return;

      if (pref) {
        prefNameEl.textContent = `★ ${pref.name}`;
        prefNameEl.style.color = 'var(--accent-cyan)';
        if (btnClearPref) btnClearPref.style.display = 'inline-flex';

        // Check if the preferred device is currently selected and active
        const currentSelectedId = this.midi.selectedInputId;
        const isCurrentlySelected = pref.id === 'all'
          ? currentSelectedId === 'all'
          : (currentSelectedId === pref.id || this.midi.inputs.some(d => d.id === currentSelectedId && pref.name && d.name && d.name.toLowerCase() === pref.name.toLowerCase()));

        const isConnected = pref.id === 'all' || this.midi.inputs.some(d => d.id === pref.id || (pref.name && d.name && d.name.toLowerCase() === pref.name.toLowerCase()));

        if (prefBadgeEl) {
          prefBadgeEl.style.display = 'inline-block';
          if (isCurrentlySelected) {
            prefBadgeEl.className = 'badge badge-emerald';
            prefBadgeEl.textContent = 'AUTO-SELECTED';
          } else if (isConnected) {
            prefBadgeEl.className = 'badge badge-cyan';
            prefBadgeEl.textContent = 'CONNECTED';
          } else {
            prefBadgeEl.className = 'badge badge-muted';
            prefBadgeEl.textContent = 'OFFLINE';
          }
        }

        if (btnSetPref) {
          const selectedValue = midiSelect ? midiSelect.value : '';
          const isSelectedThePref = pref.id === selectedValue || (pref.id !== 'all' && this.midi.inputs.some(d => d.id === selectedValue && pref.name && d.name && d.name.toLowerCase() === pref.name.toLowerCase()));
          btnSetPref.textContent = isSelectedThePref ? 'PREFERRED' : 'SET PREFERRED';
        }
      } else {
        prefNameEl.textContent = 'None (Auto)';
        prefNameEl.style.color = 'var(--text-muted)';
        if (prefBadgeEl) prefBadgeEl.style.display = 'none';
        if (btnClearPref) btnClearPref.style.display = 'none';
        if (btnSetPref) btnSetPref.textContent = 'SET PREFERRED';
      }
    };

    if (btnSetPref) {
      btnSetPref.addEventListener('click', () => {
        const selectedVal = midiSelect.value;
        if (selectedVal === 'all') {
          this.midi.setPreferredDevice({ id: 'all', name: 'All MIDI Inputs' });
        } else {
          const dev = this.midi.inputs.find(d => d.id === selectedVal);
          if (dev) {
            this.midi.setPreferredDevice(dev);
          } else {
            this.midi.setPreferredDevice({ id: selectedVal, name: selectedVal });
          }
        }
        btnSetPref.textContent = 'SAVED!';
        setTimeout(() => syncPreferredMidiUI(), 900);
        syncPreferredMidiUI();
      });
    }

    if (btnClearPref) {
      btnClearPref.addEventListener('click', () => {
        this.midi.clearPreferredDevice();
        syncPreferredMidiUI();
      });
    }

    // Initial sync of preferred device UI
    syncPreferredMidiUI();

    this.midi.onDeviceListChange = (inputs, selectedInputId = 'all') => {
      midiSelect.innerHTML = '<option value="all">All MIDI Inputs</option>';
      inputs.forEach(input => {
        const opt = document.createElement('option');
        opt.value = input.id;
        opt.textContent = `${input.name} (${input.manufacturer})`;
        midiSelect.appendChild(opt);
      });
      midiSelect.value = selectedInputId;

      syncMidiSteelUI();
      syncPreferredMidiUI();
    };

    this.midi.onStatusChange = (status) => {
      if (status.state === 'insecure') {
        alertBanner.style.display = 'flex';
        alertText.textContent = 'Web MIDI blocked: Page is not HTTPS or localhost. Android requires HTTPS or Port Forwarding.';
        btnBannerAction.textContent = 'HOW TO FIX';
      } else if (status.state === 'denied') {
        alertBanner.style.display = 'flex';
        alertText.textContent = `MIDI permission denied: ${status.message}.`;
        btnBannerAction.textContent = 'HELP';
      } else if (status.state === 'unsupported') {
        if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) {
          alertBanner.style.display = 'none';
          return;
        }
        alertBanner.style.display = 'flex';
        alertText.textContent = 'Web MIDI is not supported in this browser. Use Chrome, Edge, or Opera.';
        btnBannerAction.style.display = 'none';
      } else if (status.state === 'error') {
        alertBanner.style.display = 'flex';
        alertText.textContent = `MIDI error: ${status.message}.`;
        btnBannerAction.textContent = 'RETRY';
      } else if (status.state === 'ready' || status.state === 'no_devices') {
        alertBanner.style.display = 'none';
      }
    };

    midiSelect.addEventListener('change', (e) => {
      this.midi.selectInput(e.target.value);
      syncMidiSteelUI();
      syncPreferredMidiUI();
    });

    const activityLed = document.getElementById('voice-status-dot') || document.getElementById('midi-activity-led');
    let ledTimeout = null;

    this.midi.onMidiActivity = (logEvent) => {
      // Flash LED inside POLY status badge
      if (activityLed) {
        activityLed.classList.add('active');
        if (ledTimeout) clearTimeout(ledTimeout);
        ledTimeout = setTimeout(() => activityLed.classList.remove('active'), 80);
      }

      // Add to log table only if monitor is active (huge CPU/DOM win)
      if (this.isMidiMonitorEnabled) {
        this.addMidiLog(logEvent);
      }

      if (logEvent.ccNumber === 73 || logEvent.ccNumber === 74 || logEvent.type.startsWith('CC73') || logEvent.type.startsWith('CC74')) {
        const isCC74 = logEvent.ccNumber === 74 || logEvent.type.startsWith('CC74');
        const targetMode = isCC74 ? (this.synth.params.mpeTimbreTarget || 'cutoff') : 'cutoff';
        if (targetMode === 'cutoff') {
          const minLog = Math.log(20);
          const maxLog = Math.log(20000);
          const targetHz = Math.exp(minLog + (logEvent.value / 127) * (maxLog - minLog));
          this.animateCutoffTo(targetHz);
        } else if (targetMode === 'resonance') {
          const targetQ = 0.1 + (logEvent.value / 127) * 19.9;
          this.animateResonanceTo(targetQ);
        } else if (targetMode === 'osc2mix') {
          const mix = +(logEvent.value / 127).toFixed(2);
          this.updateSliderUI('osc2Mix', mix, `${Math.round(mix * 100)}%`);
        } else if (targetMode === 'lforate') {
          const minLog = Math.log(0.1);
          const maxLog = Math.log(20.0);
          const targetRate = Math.exp(minLog + (logEvent.value / 127) * (maxLog - minLog));
          this.animateLfoRateTo(targetRate);
        } else if (targetMode === 'lfodepth') {
          const depth = +(logEvent.value / 127).toFixed(2);
          this.updateSliderUI('lfoDepth', depth, `${Math.round(depth * 100)}%`);
        }
      } else if (
        logEvent.ccNumber === (Number(this.synth.params.volumeCC) || 11) ||
        (logEvent.type && logEvent.type.includes('Volume')) ||
        (this.synth.params.volumeCC === 7 ? (logEvent.ccNumber === 7 || logEvent.type.startsWith('CC7 ')) : (logEvent.ccNumber === 11 || logEvent.type.startsWith('CC11')))
      ) {
        const vol = +(logEvent.value / 127).toFixed(2);
        this.synth.params.masterVolume = vol;
        if (this.synth.masterGain) {
          const scaled = vol * (this.synth.masterHeadroomGain || 0.82);
          this.synth.masterGain.gain.setTargetAtTime(scaled, this.synth.ctx.currentTime, 0.01);
        }
        this.updateSliderUI('masterVolume', vol, `${Math.round(vol * 100)}%`);
      } else if (logEvent.ccNumber === 1 || logEvent.type.startsWith('CC1 ') || logEvent.type.includes('(Resonance)') || logEvent.type.includes('(LFO Rate)')) {
        if (this.synth.params.cc1Target === 'lforate') {
          const minLog = Math.log(0.1);
          const maxLog = Math.log(20.0);
          const targetRate = Math.exp(minLog + (logEvent.value / 127) * (maxLog - minLog));
          this.animateLfoRateTo(targetRate);
        } else {
          const targetQ = 0.1 + (logEvent.value / 127) * 19.9;
          this.animateResonanceTo(targetQ);
        }
      }
    };

    // Initial silent check / request
    await this.midi.requestAccess();
    syncMidiSteelUI();

    // 3. Panic Button
    const btnPanic = document.getElementById('btn-panic');
    btnPanic.addEventListener('click', () => {
      this.synth.panic();
      this.activeMouseNotes.clear();
      this.activeKeyNotes.clear();
      this.clearKeyHighlights();
    });

    // 4. Voice Allocation LEDs
    this.initVoiceMeters();
    this.synth.onVoiceStateChange = (states) => this.renderVoiceMeters(states);

    // 5. Build Keyboard
    this.buildKeyboard();
    this.bindComputerKeys();

    // 6. Bind Synth Controls & Oscillator Tabs
    this.bindControls();
    this.initOscillatorTabs();

    // 7. Setup Presets
    await this.initPresets();

    // 8. Setup MPE Performance Controls & 2D Touchpad
    this.initPerformanceSection();

    // 9. Setup Visualizer controls (oscilloscope ON by default)
    this.setupVisualizerControls();

    // 10. Screen Wake Lock (prevents mobile/tablet sleep during playback)
    this.initWakeLock();

    // 11. Performance Controls Visibility (Show/Hide Touchpad & Keyboard)
    this.initPerformanceVisibility();
  }

  // --- Screen Wake Lock Management (Mobile Screen Stay-Awake) ---

  initWakeLock() {
    // If running in native Capacitor (iOS/Android), OS flags handle screen keep-awake natively
    const isNative = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform();
    if (isNative) {
      const wakeLockSection = document.getElementById('settings-wake-lock-section');
      if (wakeLockSection) wakeLockSection.style.display = 'none';
      return;
    }

    this.wakeLock = null;
    this.keepScreenAwake = localStorage.getItem('synth_keep_screen_awake') !== 'false';
    this.fallbackVideo = null;

    // Create persistent invisible video element for universal mobile fallback (NoSleep technique).
    // Android OS, iOS, and Moto Display kernel always keep screen awake during active media playback,
    // regardless of HTTP/HTTPS, Screen Attention, or browser API restrictions.
    try {
      this.fallbackVideo = document.createElement('video');
      this.fallbackVideo.setAttribute('playsinline', '');
      this.fallbackVideo.setAttribute('webkit-playsinline', '');
      this.fallbackVideo.setAttribute('muted', '');
      this.fallbackVideo.muted = true;
      this.fallbackVideo.loop = true;
      this.fallbackVideo.style.position = 'fixed';
      this.fallbackVideo.style.top = '-9999px';
      this.fallbackVideo.style.left = '-9999px';
      this.fallbackVideo.style.width = '1px';
      this.fallbackVideo.style.height = '1px';
      this.fallbackVideo.style.opacity = '0.001';
      this.fallbackVideo.style.pointerEvents = 'none';

      // 1-second tiny blank silent WebM video data URI
      const base64Webm = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAQPEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggP57AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDBEiYhAj0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WI+uLdxUei7SacgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QCYloA4JCwgQK6gQKagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYyLjMuMTAwc3PWY8CLY8WI+uLdxUei7SZnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjExLjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QlDngQCjo4EAAIAQAgCdASoCAAIAAEcIhYWIhYSIAgIADA1gAP7/q1CAo5WBACgAsQEADBGMABgAGFgv9AAIAACjlYEAUACxAQAPEfwAGAAYWC/0AAgAAKOVgQB4ALEBAA8R/AAYABhYL/QACAAAo5WBAKAAsQEADxH8ABgAGFgv9AAIAACjlYEAyACxAQAPEfwAGAAYWC/0AAgAAKOVgQDwALEBAA8R/AAYABhYL/QACAAAo5WBARgAsQEADxCMFGAAYWC/0AAgAACjlYEBQACxAQAPEfwAGAAYWC/0AAgAAKOVgQFoALEBAA8R/AAYABhYL/QACAAAo5WBAZAAsQEADxH8ABgAGFgv9AAIAACjlYEBuACxAQAPEfwAGAAYWC/0AAgAAKOVgQHgALEBAA8R/AAYABhYL/QACAAAo5WBAggAsQEADxH8ABgAGFgv9AAIAACjlYECMACxAQAPEfwAGAAYWC/0AAgAAKOVgQJYALEBAA8R/AAYABhYL/QACAAAo5WBAoAAsQEADxH8ABgAGFgv9AAIAACjlYECqACxAQAPEfwAGAAYWC/0AAgAAKOVgQLQALEBAA8QrBRgAGFgv9AAIAAAo5WBAvgAsQEADxH8ABgAGFgv9AAIAACjlYEDIACxAQAPEfwAGAAYWC/0AAgAAKOVgQNIALEBAA8R/AAYABhYL/QACAAAo5WBA3AAsQEADxH8ABgAGFgv9AAIAACjlYEDmACxAQAPEfwAGAAYWC/0AAgAAKOVgQPAALEBAA8R/AAYABhYL/QACAAAHFO7a5G7j7OBALeK94EB8YIBo/CBAw==';
      this.fallbackVideo.src = `data:video/webm;base64,${base64Webm}`;
      document.body.appendChild(this.fallbackVideo);
    } catch (_) {}

    const wakeLockToggle = document.getElementById('toggle-wake-lock');
    const wakeLockStatus = document.getElementById('wake-lock-status');

    const updateStatusUI = () => {
      if (!wakeLockStatus) return;
      if (this.wakeLock || (this.fallbackVideo && !this.fallbackVideo.paused)) {
        wakeLockStatus.textContent = this.wakeLock ? 'AWAKE (API)' : 'AWAKE (MEDIA)';
        wakeLockStatus.className = 'badge badge-emerald';
      } else if (this.keepScreenAwake) {
        wakeLockStatus.textContent = this.synth.isAudioStarted ? 'ACQUIRING...' : 'ON AUDIO START';
        wakeLockStatus.className = 'badge badge-cyan';
      } else {
        wakeLockStatus.textContent = 'DISABLED';
        wakeLockStatus.className = 'badge badge-muted';
      }
    };

    if (wakeLockToggle) {
      wakeLockToggle.checked = this.keepScreenAwake;
      wakeLockToggle.addEventListener('change', async (e) => {
        this.keepScreenAwake = e.target.checked;
        localStorage.setItem('synth_keep_screen_awake', this.keepScreenAwake);
        if (this.keepScreenAwake) {
          if (this.synth.isAudioStarted) {
            await this.requestWakeLock();
          }
        } else {
          await this.releaseWakeLock();
        }
        updateStatusUI();
      });
    }

    // Re-acquire wake lock when returning to the tab/app
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && this.keepScreenAwake && this.synth.isAudioStarted) {
        await this.requestWakeLock();
      }
    });

    this.updateWakeLockUI = updateStatusUI;
    updateStatusUI();
  }

  async requestWakeLock() {
    if (!this.keepScreenAwake) return;

    // 1. Try W3C Screen Wake Lock API (requires HTTPS or localhost)
    if ('wakeLock' in navigator) {
      try {
        if (!this.wakeLock) {
          this.wakeLock = await navigator.wakeLock.request('screen');
          this.wakeLock.addEventListener('release', () => {
            this.wakeLock = null;
            if (this.updateWakeLockUI) this.updateWakeLockUI();
          });
        }
      } catch (err) {
        console.warn('Screen Wake Lock API rejected (non-HTTPS or battery saver active):', err);
      }
    }

    // 2. Universal Mobile Fallback: Silent Video Keep-Alive
    // Android OS, iOS, and Moto Display kernel always keep screen awake during active media playback.
    if (this.fallbackVideo) {
      try {
        this.fallbackVideo.currentTime = 0;
        await this.fallbackVideo.play();
      } catch (err) {
        console.warn('Wake Lock video fallback play failed:', err);
      }
    }

    if (this.updateWakeLockUI) this.updateWakeLockUI();
  }

  async releaseWakeLock() {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
      } catch (_) {}
      this.wakeLock = null;
    }
    if (this.fallbackVideo) {
      try {
        this.fallbackVideo.pause();
      } catch (_) {}
    }
    if (this.updateWakeLockUI) this.updateWakeLockUI();
  }

  // --- Performance Controls Visibility (MPE Touchpad & Keyboard) ---

  initPerformanceVisibility() {
    const bottomSection = document.getElementById('bottom-play-section');
    const toggleTouchpad = document.getElementById('toggle-show-touchpad');
    const toggleKeyboard = document.getElementById('toggle-show-keyboard');
    const statusTouchpad = document.getElementById('touchpad-vis-status');
    const statusKeyboard = document.getElementById('keyboard-vis-status');

    let showTouchpad = localStorage.getItem('synth_show_touchpad') !== 'false';
    let showKeyboard = localStorage.getItem('synth_show_keyboard') !== 'false';

    const updateVisibility = () => {
      if (toggleTouchpad) toggleTouchpad.checked = showTouchpad;
      if (toggleKeyboard) toggleKeyboard.checked = showKeyboard;

      if (statusTouchpad) {
        statusTouchpad.textContent = showTouchpad ? 'SHOWN' : 'HIDDEN';
        statusTouchpad.className = showTouchpad ? 'badge badge-emerald' : 'badge badge-muted';
      }
      if (statusKeyboard) {
        statusKeyboard.textContent = showKeyboard ? 'SHOWN' : 'HIDDEN';
        statusKeyboard.className = showKeyboard ? 'badge badge-emerald' : 'badge badge-muted';
      }

      if (bottomSection) {
        bottomSection.classList.toggle('hide-touchpad', !showTouchpad);
        bottomSection.classList.toggle('hide-keyboard', !showKeyboard);
      }
    };

    updateVisibility();

    toggleTouchpad?.addEventListener('change', (e) => {
      showTouchpad = e.target.checked;
      localStorage.setItem('synth_show_touchpad', showTouchpad);
      updateVisibility();
    });

    toggleKeyboard?.addEventListener('change', (e) => {
      showKeyboard = e.target.checked;
      localStorage.setItem('synth_show_keyboard', showKeyboard);
      updateVisibility();
    });
  }

  setupVisualizerControls() {
    const btnToggleOsc = document.getElementById('btn-toggle-osc');
    const oscCard = document.getElementById('oscilloscope-card');
    const oscBadge = document.getElementById('osc-badge');
    if (!btnToggleOsc || !oscCard) return;

    // Oscilloscope ON by default across all platforms
    let isEnabled = true;
    if (this.visualizer) {
      this.visualizer.setOscilloscopeEnabled(isEnabled);
    }

    const updateOscUI = (enabled) => {
      if (enabled) {
        oscCard.classList.remove('collapsed');
        btnToggleOsc.textContent = 'HIDE';
        oscBadge.textContent = 'LIVE';
        oscBadge.classList.remove('badge-muted');
      } else {
        oscCard.classList.add('collapsed');
        btnToggleOsc.textContent = 'SHOW';
        oscBadge.textContent = 'PAUSED';
        oscBadge.classList.add('badge-muted');
      }
    };

    updateOscUI(isEnabled);

    btnToggleOsc.onclick = () => {
      isEnabled = !isEnabled;
      if (this.visualizer) {
        this.visualizer.setOscilloscopeEnabled(isEnabled);
      }
      updateOscUI(isEnabled);
    };
  }

  // --- Voice Active Counter (Top Header) ---

  initVoiceMeters() {
    this.updateVoiceCount(0);
    const maxVoiceEl = document.getElementById('voice-count-max');
    if (maxVoiceEl) maxVoiceEl.textContent = `/${this.synth.voiceCount}`;
  }

  updateVoiceCount(count) {
    const numEl = document.getElementById('active-voice-count');
    const badgeEl = document.getElementById('voice-count-badge');
    if (numEl) numEl.textContent = count;
    if (badgeEl) {
      if (count > 0) {
        badgeEl.classList.add('active');
      } else {
        badgeEl.classList.remove('active');
      }
    }
  }

  renderVoiceMeters(states) {
    const activeCount = states.filter(v => v.isActive && !v.isReleasing).length;
    this.updateVoiceCount(activeCount);

    // Update virtual keyboard key highlights
    this.updateKeyboardHighlights(states);
  }

  // --- Presets (Factory & User Patches) ---

  async initPresets() {
    await this.presetManager.init();

    const select = document.getElementById('preset-select');
    select?.addEventListener('change', (e) => {
      this.loadPreset(e.target.value);
    });

    const btnSave = document.getElementById('btn-save-preset');
    const btnDelete = document.getElementById('btn-delete-preset');
    const btnPrev = document.getElementById('btn-prev-preset');
    const btnNext = document.getElementById('btn-next-preset');

    const handleNav = (dir, e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      this.navigatePreset(dir);
    };

    let lastNavTime = 0;
    const safeNav = (dir, e) => {
      const now = Date.now();
      if (now - lastNavTime < 180) return;
      lastNavTime = now;
      handleNav(dir, e);
    };

    btnPrev?.addEventListener('click', (e) => safeNav(-1, e));
    btnPrev?.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') safeNav(-1, e);
    });
    btnNext?.addEventListener('click', (e) => safeNav(1, e));
    btnNext?.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') safeNav(1, e);
    });

    btnSave?.addEventListener('click', () => {
      this.openSavePresetModal();
    });

    btnDelete?.addEventListener('click', () => {
      this.openDeletePresetModal();
    });

    this.setupPresetModals();

    // Hook parameter changes to update dirty indicator and persist session
    this.synth.onParamChange = () => {
      this.updatePresetModifiedIndicator();
    };

    // Check for persisted active session across refreshes/relaunches
    const savedSession = await this.loadActiveSession();
    if (savedSession && this.presetManager.getPresetById(savedSession.presetId)) {
      const basePreset = this.presetManager.getPresetById(savedSession.presetId);
      this.currentPresetId = basePreset.id;
      this.presetManager.setBaselinePreset(basePreset);

      // Restore exact synthesizer parameters
      this.synth.applyPreset({ params: savedSession.params });
      this.syncUIFromParams(this.synth.params);
      this.visualizer?.markFilterDirty();

      // Check if modified compared to original baseline
      this.presetManager.checkModified(savedSession.params);
      this.renderPresetDropdown(basePreset.id);
    } else {
      // Fallback to first factory preset
      const initial = this.presetManager.getFactoryPresets()[0];
      if (initial) {
        this.loadPreset(initial.id);
      }
    }
  }

  renderPresetDropdown(selectedId = null) {
    const select = document.getElementById('preset-select');
    if (!select) return;

    const userPresets = this.presetManager.getUserPresets();
    const factoryPresets = this.presetManager.getFactoryPresets();
    const targetId = selectedId || this.currentPresetId || factoryPresets[0]?.id;
    this.currentPresetId = targetId;

    select.innerHTML = '';
    const isModified = this.presetManager.isModified;

    // 1. User Presets (custom patches created by user)
    if (userPresets.length > 0) {
      const userGroup = document.createElement('optgroup');
      userGroup.label = 'User Presets';
      userPresets.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        const dirty = (p.id === targetId && isModified);
        opt.textContent = dirty ? `${p.name} *` : p.name;
        userGroup.appendChild(opt);
      });
      select.appendChild(userGroup);
    }

    // 2. Factory Presets (no default asterisk; asterisk only appears when modified)
    const factoryGroup = document.createElement('optgroup');
    factoryGroup.label = 'Factory Presets';
    factoryPresets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      const dirty = (p.id === targetId && isModified);
      opt.textContent = dirty ? `${p.name} *` : p.name;
      factoryGroup.appendChild(opt);
    });
    select.appendChild(factoryGroup);

    if (targetId) {
      select.value = targetId;
    }
    const currentPreset = this.presetManager.getPresetById(targetId);
    if (currentPreset) {
      this.updatePresetDisplayName(currentPreset.name, isModified);
    }
    this.updatePresetButtonsState();
  }

  updatePresetDisplayName(name, isModified = false) {
    const textEl = document.getElementById('preset-display-text');
    if (!textEl) return;
    const cleanName = isModified ? `${name} *` : name;
    if (textEl.textContent !== cleanName) {
      textEl.textContent = cleanName;
    }
    // Crop/marquee behavior: if longer than 29 characters, enable marquee animation
    if (cleanName.length > 29) {
      textEl.classList.add('marquee');
      textEl.title = cleanName;
    } else {
      textEl.classList.remove('marquee');
      textEl.title = cleanName;
    }
  }

  updatePresetModifiedIndicator() {
    const isDirty = this.presetManager.checkModified(this.synth.params);
    const select = document.getElementById('preset-select');
    const preset = this.presetManager.getPresetById(this.currentPresetId);
    if (preset) {
      this.updatePresetDisplayName(preset.name, isDirty);
      if (select) {
        const opt = select.querySelector(`option[value="${this.currentPresetId}"]`);
        if (opt) {
          const newText = isDirty ? `${preset.name} *` : preset.name;
          if (opt.textContent !== newText) {
            opt.textContent = newText;
          }
        }
      }
    }

    this.saveActiveSession();
  }

  saveActiveSession() {
    if (this._sessionSaveTimeout) {
      clearTimeout(this._sessionSaveTimeout);
    }
    this._sessionSaveTimeout = setTimeout(() => {
      try {
        const sessionData = {
          presetId: this.currentPresetId,
          params: JSON.parse(JSON.stringify(this.synth.params)),
          isModified: this.presetManager.isModified
        };
        localStorage.setItem('poly_mpe_active_session_v1', JSON.stringify(sessionData));
        if (typeof window !== 'undefined' && window.Capacitor?.Plugins?.Preferences) {
          window.Capacitor.Plugins.Preferences.set({
            key: 'poly_mpe_active_session_v1',
            value: JSON.stringify(sessionData)
          });
        }
      } catch (e) {
        console.warn('Failed to save active session:', e);
      }
    }, 100);
  }

  async loadActiveSession() {
    try {
      let raw = null;
      if (typeof window !== 'undefined' && window.Capacitor?.Plugins?.Preferences) {
        const res = await window.Capacitor.Plugins.Preferences.get({ key: 'poly_mpe_active_session_v1' });
        raw = res.value;
      }
      if (!raw && typeof localStorage !== 'undefined') {
        raw = localStorage.getItem('poly_mpe_active_session_v1');
      }
      if (raw) {
        const data = JSON.parse(raw);
        if (data && data.presetId && data.params) {
          return data;
        }
      }
    } catch (e) {
      console.warn('Failed to load active session:', e);
    }
    return null;
  }

  updatePresetButtonsState() {
    const btnDelete = document.getElementById('btn-delete-preset');
    const currentPreset = this.presetManager.getPresetById(this.currentPresetId);

    if (btnDelete) {
      const isUserPreset = currentPreset && !currentPreset.isFactory;
      btnDelete.disabled = !isUserPreset;
      btnDelete.title = isUserPreset ? `Delete "${currentPreset.name}"` : 'Factory presets cannot be deleted';
    }
  }

  loadPreset(id) {
    const preset = this.presetManager.getPresetById(id);
    if (!preset) return;

    // Preserve user routing / controller preferences across patch loads
    const savedCc1Target = this.synth.params.cc1Target;
    const savedVolumeCC = this.synth.params.volumeCC;
    const savedMpePitchBendRange = this.synth.params.mpePitchBendRange;
    const savedPressureTarget = this.synth.params.mpePressureTarget;
    const savedTimbreTarget = this.synth.params.mpeTimbreTarget;

    this.currentPresetId = preset.id;
    this.presetManager.setBaselinePreset(preset);

    this.synth.applyPreset(preset);
    if (savedCc1Target) this.synth.params.cc1Target = savedCc1Target;
    if (savedVolumeCC) this.synth.params.volumeCC = savedVolumeCC;
    if (savedMpePitchBendRange) this.synth.params.mpePitchBendRange = savedMpePitchBendRange;
    if (savedPressureTarget) this.synth.params.mpePressureTarget = savedPressureTarget;
    if (savedTimbreTarget) this.synth.params.mpeTimbreTarget = savedTimbreTarget;

    this.syncUIFromParams(this.synth.params);
    this.visualizer?.markFilterDirty();

    this.renderPresetDropdown(preset.id);
    this.saveActiveSession();
  }

  navigatePreset(direction) {
    const allPresets = this.presetManager.getAllPresets();
    if (!allPresets || allPresets.length === 0) return;

    const select = document.getElementById('preset-select');
    const targetId = this.currentPresetId || select?.value;
    let currentIndex = allPresets.findIndex(p => p.id === targetId);
    if (currentIndex === -1) currentIndex = 0;

    let nextIndex = (currentIndex + direction) % allPresets.length;
    if (nextIndex < 0) nextIndex += allPresets.length;

    const nextPreset = allPresets[nextIndex];
    if (nextPreset) {
      this.loadPreset(nextPreset.id);
    }
  }

  // --- Save / Edit Preset Modal ---

  setupPresetModals() {
    // Save Modal bindings
    const saveModal = document.getElementById('save-preset-modal');
    const btnCloseSave = document.getElementById('btn-close-save-modal');
    const btnCancelSave = document.getElementById('btn-cancel-save-modal');
    const btnConfirmSave = document.getElementById('btn-confirm-save-modal');
    const inputName = document.getElementById('input-preset-name');

    const closeSave = () => {
      if (saveModal) saveModal.style.display = 'none';
    };

    btnCloseSave?.addEventListener('click', closeSave);
    btnCancelSave?.addEventListener('click', closeSave);
    saveModal?.addEventListener('click', (e) => {
      if (e.target === saveModal) closeSave();
    });

    btnConfirmSave?.addEventListener('click', async () => {
      await this.handleSavePreset();
    });

    inputName?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await this.handleSavePreset();
      } else if (e.key === 'Escape') {
        closeSave();
      }
    });

    // Delete Modal bindings
    const deleteModal = document.getElementById('delete-preset-modal');
    const btnCloseDelete = document.getElementById('btn-close-delete-modal');
    const btnCancelDelete = document.getElementById('btn-cancel-delete-modal');
    const btnConfirmDelete = document.getElementById('btn-confirm-delete-modal');

    const closeDelete = () => {
      if (deleteModal) deleteModal.style.display = 'none';
    };

    btnCloseDelete?.addEventListener('click', closeDelete);
    btnCancelDelete?.addEventListener('click', closeDelete);
    deleteModal?.addEventListener('click', (e) => {
      if (e.target === deleteModal) closeDelete();
    });

    btnConfirmDelete?.addEventListener('click', async () => {
      await this.handleDeletePreset();
    });
  }

  openSavePresetModal() {
    const currentPreset = this.presetManager.getPresetById(this.currentPresetId);
    const modal = document.getElementById('save-preset-modal');
    const inputName = document.getElementById('input-preset-name');
    const modeGroup = document.getElementById('save-mode-group');
    const modalTitle = document.getElementById('save-modal-title');
    const modalDesc = document.getElementById('save-modal-desc');

    if (!modal || !inputName) return;

    const isUserPreset = currentPreset && !currentPreset.isFactory;

    if (isUserPreset) {
      if (modalTitle) modalTitle.textContent = '💾 Edit / Save Preset';
      if (modalDesc) modalDesc.textContent = `Update "${currentPreset.name}" or save as a new patch:`;
      inputName.value = currentPreset.name;
      if (modeGroup) modeGroup.style.display = 'flex';
      const overwriteRadio = document.querySelector('input[name="save-mode"][value="overwrite"]');
      if (overwriteRadio) overwriteRadio.checked = true;
    } else {
      if (modalTitle) modalTitle.textContent = '💾 Save User Preset';
      if (modalDesc) modalDesc.textContent = `Save current sound settings as a new custom preset:`;
      inputName.value = `${currentPreset ? currentPreset.name : 'Custom Patch'} (Copy)`;
      if (modeGroup) modeGroup.style.display = 'none';
    }

    modal.style.display = 'flex';
    setTimeout(() => {
      inputName.focus();
      inputName.select();
    }, 50);
  }

  async handleSavePreset() {
    const inputName = document.getElementById('input-preset-name');
    const modal = document.getElementById('save-preset-modal');
    if (!inputName) return;

    const name = inputName.value.trim() || 'Custom Patch';
    const currentPreset = this.presetManager.getPresetById(this.currentPresetId);
    const isUserPreset = currentPreset && !currentPreset.isFactory;

    let targetId = null;
    if (isUserPreset) {
      const mode = document.querySelector('input[name="save-mode"]:checked')?.value;
      if (mode === 'overwrite') {
        targetId = currentPreset.id;
      }
    }

    const saved = await this.presetManager.saveUserPreset(name, this.synth.params, targetId);
    if (modal) modal.style.display = 'none';

    this.renderPresetDropdown(saved.id);
    this.loadPreset(saved.id);
  }

  openDeletePresetModal() {
    const currentPreset = this.presetManager.getPresetById(this.currentPresetId);
    if (!currentPreset || currentPreset.isFactory) return;

    const modal = document.getElementById('delete-preset-modal');
    const text = document.getElementById('delete-modal-text');
    if (!modal) return;

    if (text) {
      text.textContent = `Are you sure you want to delete "${currentPreset.name}"? This cannot be undone.`;
    }
    modal.style.display = 'flex';
  }

  async handleDeletePreset() {
    const modal = document.getElementById('delete-preset-modal');
    const currentPreset = this.presetManager.getPresetById(this.currentPresetId);
    if (!currentPreset || currentPreset.isFactory) return;

    await this.presetManager.deleteUserPreset(currentPreset.id);
    if (modal) modal.style.display = 'none';

    // Fallback to first preset
    const fallbackId = this.presetManager.getAllPresets()[0]?.id;
    this.renderPresetDropdown(fallbackId);
    if (fallbackId) {
      this.loadPreset(fallbackId);
    }
  }

  syncUIFromParams(params) {
    // Oscillators
    this.setButtonGroup('osc1Waveform', params.osc1Waveform);
    this.updateSliderUI('osc1Octave', params.osc1Octave, params.osc1Octave);
    this.updateSliderUI('osc1Semi', params.osc1Semi, params.osc1Semi);
    this.updateSliderUI('osc1Fine', params.osc1Fine, (params.osc1Fine > 0 ? '+' : '') + params.osc1Fine);

    this.setButtonGroup('osc2Waveform', params.osc2Waveform);
    this.updateSliderUI('osc2Octave', params.osc2Octave, params.osc2Octave);
    this.updateSliderUI('osc2Semi', params.osc2Semi, params.osc2Semi);
    this.updateSliderUI('osc2Fine', params.osc2Fine, (params.osc2Fine > 0 ? '+' : '') + params.osc2Fine);
    this.updateSliderUI('osc2Mix', params.osc2Mix, `${Math.round(params.osc2Mix * 100)}%`);

    // Filter
    this.updateSliderUI('filterCutoff', params.filterCutoff, `${Math.round(params.filterCutoff)} Hz`);
    this.updateSliderUI('filterResonance', params.filterResonance, Number(params.filterResonance).toFixed(1));
    this.updateSliderUI('filterEnvAmount', params.filterEnvAmount, `${Math.round(params.filterEnvAmount * 100)}%`);
    this.updateSliderUI('filterKeyTracking', params.filterKeyTracking, `${Math.round(params.filterKeyTracking * 100)}%`);
    this.updateSliderUI('filterAttack', params.filterAttack, `${Math.round(params.filterAttack * 1000)}ms`);
    this.updateSliderUI('filterDecay', params.filterDecay, `${params.filterDecay}s`);
    this.updateSliderUI('filterSustain', params.filterSustain, `${Math.round(params.filterSustain * 100)}%`);
    this.updateSliderUI('filterRelease', params.filterRelease, `${params.filterRelease}s`);

    const readout = document.getElementById('filter-cutoff-readout');
    if (readout) readout.textContent = `${Math.round(params.filterCutoff)} Hz`;

    // Amp
    this.updateSliderUI('ampAttack', params.ampAttack, `${Math.round(params.ampAttack * 1000)}ms`);
    this.updateSliderUI('ampDecay', params.ampDecay, `${params.ampDecay}s`);
    this.updateSliderUI('ampSustain', params.ampSustain, `${Math.round(params.ampSustain * 100)}%`);
    this.updateSliderUI('ampRelease', params.ampRelease, `${params.ampRelease}s`);
    this.updateSliderUI('masterVolume', params.masterVolume, `${Math.round(params.masterVolume * 100)}%`);

    // LFO
    this.setButtonGroup('lfoWaveform', params.lfoWaveform);
    this.setButtonGroup('lfoTarget', params.lfoTarget);
    this.updateSliderUI('lfoRate', params.lfoRate, `${params.lfoRate} Hz`);
    this.updateSliderUI('lfoDepth', params.lfoDepth, `${Math.round(params.lfoDepth * 100)}%`);

    // Distortion
    const distCheck = document.getElementById('distortionEnabled');
    if (distCheck) distCheck.checked = Boolean(params.distortionEnabled);
    this.updateSliderUI('distortionDrive', params.distortionDrive ?? 20, params.distortionDrive ?? 20);
    const distTone = params.distortionTone ?? 4000;
    this.updateSliderUI('distortionTone', distTone, distTone >= 1000 ? `${(distTone / 1000).toFixed(1)} kHz` : `${distTone} Hz`);
    this.updateSliderUI('distortionMix', params.distortionMix ?? 0.5, `${Math.round((params.distortionMix ?? 0.5) * 100)}%`);

    // Delay
    const delayCheck = document.getElementById('delayEnabled');
    if (delayCheck) delayCheck.checked = Boolean(params.delayEnabled);
    this.updateSliderUI('delayTime', params.delayTime, `${Math.round(params.delayTime * 1000)}ms`);
    this.updateSliderUI('delayFeedback', params.delayFeedback, `${Math.round(params.delayFeedback * 100)}%`);
    this.updateSliderUI('delayMix', params.delayMix, `${Math.round(params.delayMix * 100)}%`);

    // Reverb
    const reverbCheck = document.getElementById('reverbEnabled');
    if (reverbCheck) reverbCheck.checked = Boolean(params.reverbEnabled);
    this.updateSliderUI('reverbTime', params.reverbTime ?? 2.2, `${params.reverbTime ?? 2.2}s`);
    const revDamp = params.reverbDamp ?? 3500;
    this.updateSliderUI('reverbDamp', revDamp, revDamp >= 1000 ? `${(revDamp / 1000).toFixed(1)} kHz` : `${revDamp} Hz`);
    this.updateSliderUI('reverbMix', params.reverbMix ?? 0.3, `${Math.round((params.reverbMix ?? 0.3) * 100)}%`);

    // MPE Pitch Bend Range Dropdown
    const mpeBendSelect = document.getElementById('mpe-bend-select');
    if (mpeBendSelect && params.mpePitchBendRange !== undefined) {
      mpeBendSelect.value = params.mpePitchBendRange.toString();
    }

    // CC1 Mod Wheel Destination Dropdown
    const cc1TargetSelect = document.getElementById('cc1-target-select');
    if (cc1TargetSelect && params.cc1Target !== undefined) {
      cc1TargetSelect.value = params.cc1Target;
    }

    // Volume CC Destination Dropdown
    const volumeCcSelect = document.getElementById('volume-cc-select');
    if (volumeCcSelect && params.volumeCC !== undefined) {
      volumeCcSelect.value = String(params.volumeCC);
    }

    // MPE Pressure Destination Dropdown
    const pressureTargetSelect = document.getElementById('pressure-target-select');
    if (pressureTargetSelect && params.mpePressureTarget !== undefined) {
      pressureTargetSelect.value = params.mpePressureTarget;
    }

    // MPE Slide / Timbre Destination Dropdown
    const timbreTargetSelect = document.getElementById('mpe-timbre-target-select');
    if (timbreTargetSelect && params.mpeTimbreTarget !== undefined) {
      timbreTargetSelect.value = params.mpeTimbreTarget;
    }

    this.currentDisplayCutoff = params.filterCutoff;
    if (this.cutoffAnimFrame) {
      cancelAnimationFrame(this.cutoffAnimFrame);
      this.cutoffAnimFrame = null;
    }
    this.currentDisplayResonance = params.filterResonance;
    if (this.resoAnimFrame) {
      cancelAnimationFrame(this.resoAnimFrame);
      this.resoAnimFrame = null;
    }
    this.currentDisplayLfoRate = params.lfoRate;
    if (this.lfoRateAnimFrame) {
      cancelAnimationFrame(this.lfoRateAnimFrame);
      this.lfoRateAnimFrame = null;
    }

    this.updateSharedModulationBadges();
  }

  updateSharedModulationBadges() {
    const badgeTimbre = document.getElementById('badge-mpe-timbre');
    const badgePressure = document.getElementById('badge-mpe-pressure');
    const badgeCc1 = document.getElementById('badge-cc1');

    const timbre = this.synth.params.mpeTimbreTarget || 'cutoff';
    const pressure = this.synth.params.mpePressureTarget || 'both';
    const cc1 = this.synth.params.cc1Target || 'resonance';

    // Shared destination detection
    const cutoffShared = (timbre === 'cutoff') && (pressure === 'both' || pressure === 'filter');
    const resoShared = (timbre === 'resonance') && (cc1 === 'resonance');
    const lfoRateShared = (timbre === 'lforate') && (cc1 === 'lforate');

    if (badgeTimbre) {
      if (cutoffShared || resoShared || lfoRateShared) {
        badgeTimbre.textContent = 'MPE (Shared)';
        badgeTimbre.title = 'Shared destination: Modulates additively with other active controls';
        badgeTimbre.className = 'badge badge-emerald';
      } else {
        badgeTimbre.textContent = 'MPE';
        badgeTimbre.title = '';
        badgeTimbre.className = 'badge badge-cyan';
      }
    }

    if (badgePressure) {
      if (cutoffShared) {
        badgePressure.textContent = 'PRESS (Shared)';
        badgePressure.title = 'Shared destination: Modulates additively with MPE Slide';
        badgePressure.className = 'badge badge-emerald';
      } else {
        badgePressure.textContent = 'PRESS';
        badgePressure.title = '';
        badgePressure.className = 'badge badge-cyan';
      }
    }

    if (badgeCc1) {
      if (resoShared || lfoRateShared) {
        badgeCc1.textContent = 'MOD (Shared)';
        badgeCc1.title = 'Shared destination: Modulates additively with MPE Slide';
        badgeCc1.className = 'badge badge-emerald';
      } else {
        badgeCc1.textContent = 'MOD';
        badgeCc1.title = '';
        badgeCc1.className = 'badge badge-amber';
      }
    }
  }

  setButtonGroup(param, value) {
    const group = document.querySelector(`[data-param="${param}"]`);
    if (!group) return;
    group.querySelectorAll('.btn-tab').forEach(b => {
      if (b.dataset.value === value) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });
  }

  /**
   * Smooth continuous analog slew interpolation for incoming MIDI CC73/CC74.
   * Glides the UI slider, readout, and engine cutoff smoothly at 60fps
   * eliminating 60Hz discrete stepping and providing an authentic analog dial feel.
   */
  animateCutoffTo(targetHz) {
    this.targetCutoffHz = targetHz;
    if (this.cutoffAnimFrame) return;

    const step = () => {
      const current = this.currentDisplayCutoff !== undefined
        ? this.currentDisplayCutoff
        : (this.synth.params.filterCutoff || 2500);

      const diff = this.targetCutoffHz - current;
      if (Math.abs(diff) < 1.0) {
        this.currentDisplayCutoff = this.targetCutoffHz;
        this.synth.params.filterCutoff = this.targetCutoffHz;
        const displayHz = Math.round(this.targetCutoffHz);
        this.updateSliderUI('filterCutoff', displayHz, `${displayHz} Hz`);
        const readout = document.getElementById('filter-cutoff-readout');
        if (readout) readout.textContent = `${displayHz} Hz`;
        this.visualizer?.markFilterDirty();
        this.cutoffAnimFrame = null;
        return;
      }

      // Analog ballistic exponential tracking towards incoming MIDI CC frequency
      const next = current + diff * 0.28;
      this.currentDisplayCutoff = next;
      this.synth.params.filterCutoff = next;
      const displayHz = Math.round(next);
      this.updateSliderUI('filterCutoff', displayHz, `${displayHz} Hz`);
      const readout = document.getElementById('filter-cutoff-readout');
      if (readout) readout.textContent = `${displayHz} Hz`;
      this.visualizer?.markFilterDirty();

      this.cutoffAnimFrame = requestAnimationFrame(step);
    };

    this.cutoffAnimFrame = requestAnimationFrame(step);
  }

  /**
   * Smooth continuous analog slew interpolation for incoming MIDI CC1 (Filter Resonance).
   * Glides the resonance slider and numeric readout at 60fps for a tactile analog dial feel.
   */
  animateResonanceTo(targetQ) {
    this.targetResonanceQ = targetQ;
    if (this.resoAnimFrame) return;

    const step = () => {
      const current = this.currentDisplayResonance !== undefined
        ? this.currentDisplayResonance
        : (this.synth.params.filterResonance ?? 1.0);

      const diff = this.targetResonanceQ - current;
      if (Math.abs(diff) < 0.04) {
        this.currentDisplayResonance = this.targetResonanceQ;
        this.synth.params.filterResonance = this.targetResonanceQ;
        this.updateSliderUI('filterResonance', this.targetResonanceQ, this.targetResonanceQ.toFixed(1));
        this.visualizer?.markFilterDirty();
        this.resoAnimFrame = null;
        return;
      }

      // Smooth ballistic tracking
      const next = current + diff * 0.28;
      this.currentDisplayResonance = next;
      this.synth.params.filterResonance = next;
      this.updateSliderUI('filterResonance', next, next.toFixed(1));
      this.visualizer?.markFilterDirty();

      this.resoAnimFrame = requestAnimationFrame(step);
    };

    this.resoAnimFrame = requestAnimationFrame(step);
  }

  /**
   * Smooth continuous analog slew interpolation for incoming MIDI CC1 (LFO Rate).
   * Glides the LFO rate slider and numeric readout smoothly across all frequencies.
   */
  animateLfoRateTo(targetRate) {
    this.targetLfoRateVal = targetRate;
    if (this.lfoRateAnimFrame) return;

    const step = () => {
      const current = this.currentDisplayLfoRate !== undefined
        ? this.currentDisplayLfoRate
        : (this.synth.params.lfoRate ?? 3.5);

      const diff = this.targetLfoRateVal - current;
      if (Math.abs(diff) < 0.04) {
        this.currentDisplayLfoRate = this.targetLfoRateVal;
        this.synth.params.lfoRate = this.targetLfoRateVal;
        this.updateSliderUI('lfoRate', this.targetLfoRateVal, `${this.targetLfoRateVal.toFixed(1)} Hz`);
        this.lfoRateAnimFrame = null;
        return;
      }

      // Smooth ballistic tracking
      const next = current + diff * 0.28;
      this.currentDisplayLfoRate = next;
      this.synth.params.lfoRate = next;
      this.updateSliderUI('lfoRate', next, `${next.toFixed(1)} Hz`);

      this.lfoRateAnimFrame = requestAnimationFrame(step);
    };

    this.lfoRateAnimFrame = requestAnimationFrame(step);
  }

  cutoffToSlider(hz) {
    const minLog = Math.log(20);
    const maxLog = Math.log(20000);
    const clamped = Math.max(20, Math.min(20000, hz || 2000));
    const norm = (Math.log(clamped) - minLog) / (maxLog - minLog);
    return Math.round(norm * 1000);
  }

  sliderToCutoff(sliderVal) {
    const minLog = Math.log(20);
    const maxLog = Math.log(20000);
    const norm = Math.max(0, Math.min(1000, parseFloat(sliderVal) || 0)) / 1000;
    const rawHz = Math.exp(minLog + norm * (maxLog - minLog));
    if (rawHz < 100) {
      return Math.round(rawHz / 2) * 2;
    } else if (rawHz < 300) {
      return Math.round(rawHz / 10) * 10;
    } else {
      // 20 Hz resolution throughout middle and upper range
      return Math.round(rawHz / 20) * 20;
    }
  }

  updateSliderUI(sliderId, value, displayStr) {
    const el = document.getElementById(sliderId);
    if (el) {
      if (sliderId === 'filterCutoff') {
        el.value = this.cutoffToSlider(value);
      } else {
        el.value = value;
      }
    }
    const disp = document.getElementById(`${sliderId}-val`);
    if (disp) disp.textContent = displayStr;
  }

  // --- Parameter Controls Binding ---

  bindControls() {
    const bindSlider = (id, paramKey, formatter) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', (e) => {
        if (paramKey === 'filterResonance' && this.resoAnimFrame) {
          cancelAnimationFrame(this.resoAnimFrame);
          this.resoAnimFrame = null;
          this.currentDisplayResonance = undefined;
        }
        if (paramKey === 'lfoRate' && this.lfoRateAnimFrame) {
          cancelAnimationFrame(this.lfoRateAnimFrame);
          this.lfoRateAnimFrame = null;
          this.currentDisplayLfoRate = undefined;
        }
        const val = parseFloat(e.target.value);
        this.synth.updateParam(paramKey, val);
        const disp = document.getElementById(`${id}-val`);
        if (disp) disp.textContent = formatter ? formatter(val) : val;

        if (paramKey === 'filterCutoff') {
          const readout = document.getElementById('filter-cutoff-readout');
          if (readout) readout.textContent = `${Math.round(val)} Hz`;
        }

        if (paramKey.startsWith('filter')) {
          this.visualizer?.markFilterDirty();
        }
      });
    };

    // Waveform & Button groups
    document.querySelectorAll('.btn-group').forEach(group => {
      const param = group.dataset.param;
      group.querySelectorAll('.btn-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          group.querySelectorAll('.btn-tab').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.synth.updateParam(param, btn.dataset.value);
        });
      });
    });

    // Oscillator 1
    bindSlider('osc1Octave', 'osc1Octave', v => v);
    bindSlider('osc1Semi', 'osc1Semi', v => v);
    bindSlider('osc1Fine', 'osc1Fine', v => (v > 0 ? '+' : '') + v);

    // Oscillator 2
    bindSlider('osc2Octave', 'osc2Octave', v => v);
    bindSlider('osc2Semi', 'osc2Semi', v => v);
    bindSlider('osc2Fine', 'osc2Fine', v => (v > 0 ? '+' : '') + v);
    bindSlider('osc2Mix', 'osc2Mix', v => `${Math.round(v * 100)}%`);

    // Filter - Cutoff with 20Hz resolution and smooth logarithmic response
    const filterCutoffEl = document.getElementById('filterCutoff');
    if (filterCutoffEl) {
      filterCutoffEl.addEventListener('input', (e) => {
        if (this.cutoffAnimFrame) {
          cancelAnimationFrame(this.cutoffAnimFrame);
          this.cutoffAnimFrame = null;
        }
        const sliderVal = parseFloat(e.target.value);
        const hz = this.sliderToCutoff(sliderVal);
        this.currentDisplayCutoff = hz;
        this.synth.updateParam('filterCutoff', hz);
        const disp = document.getElementById('filterCutoff-val');
        if (disp) disp.textContent = `${hz} Hz`;
        const readout = document.getElementById('filter-cutoff-readout');
        if (readout) readout.textContent = `${hz} Hz`;
        this.visualizer?.markFilterDirty();
      });
    }
    bindSlider('filterResonance', 'filterResonance', v => v.toFixed(1));
    bindSlider('filterEnvAmount', 'filterEnvAmount', v => `${Math.round(v * 100)}%`);
    bindSlider('filterKeyTracking', 'filterKeyTracking', v => `${Math.round(v * 100)}%`);
    bindSlider('filterAttack', 'filterAttack', v => `${Math.round(v * 1000)}ms`);
    bindSlider('filterDecay', 'filterDecay', v => `${v}s`);
    bindSlider('filterSustain', 'filterSustain', v => `${Math.round(v * 100)}%`);
    bindSlider('filterRelease', 'filterRelease', v => `${v}s`);

    // Amp
    bindSlider('ampAttack', 'ampAttack', v => `${Math.round(v * 1000)}ms`);
    bindSlider('ampDecay', 'ampDecay', v => `${v}s`);
    bindSlider('ampSustain', 'ampSustain', v => `${Math.round(v * 100)}%`);
    bindSlider('ampRelease', 'ampRelease', v => `${v}s`);
    bindSlider('masterVolume', 'masterVolume', v => `${Math.round(v * 100)}%`);

    // LFO
    bindSlider('lfoRate', 'lfoRate', v => `${v} Hz`);
    bindSlider('lfoDepth', 'lfoDepth', v => `${Math.round(v * 100)}%`);

    // Distortion
    const distCheck = document.getElementById('distortionEnabled');
    if (distCheck) {
      distCheck.addEventListener('change', (e) => {
        this.synth.updateParam('distortionEnabled', e.target.checked);
      });
    }
    bindSlider('distortionDrive', 'distortionDrive', v => `${v}`);
    bindSlider('distortionTone', 'distortionTone', v => v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${v} Hz`);
    bindSlider('distortionMix', 'distortionMix', v => `${Math.round(v * 100)}%`);

    // Delay
    const delayCheck = document.getElementById('delayEnabled');
    if (delayCheck) {
      delayCheck.addEventListener('change', (e) => {
        this.synth.updateParam('delayEnabled', e.target.checked);
      });
    }
    bindSlider('delayTime', 'delayTime', v => `${Math.round(v * 1000)}ms`);
    bindSlider('delayFeedback', 'delayFeedback', v => `${Math.round(v * 100)}%`);
    bindSlider('delayMix', 'delayMix', v => `${Math.round(v * 100)}%`);

    // Reverb
    const reverbCheck = document.getElementById('reverbEnabled');
    if (reverbCheck) {
      reverbCheck.addEventListener('change', (e) => {
        this.synth.updateParam('reverbEnabled', e.target.checked);
      });
    }
    bindSlider('reverbTime', 'reverbTime', v => `${v}s`);
    bindSlider('reverbDamp', 'reverbDamp', v => v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${v} Hz`);
    bindSlider('reverbMix', 'reverbMix', v => `${Math.round(v * 100)}%`);
  }

  // --- MPE Performance Controls & 2D Touchpad ---

  initOscillatorTabs() {
    const btnOsc1 = document.getElementById('tab-btn-osc1');
    const btnOsc2 = document.getElementById('tab-btn-osc2');
    const paneOsc1 = document.getElementById('osc1-tab');
    const paneOsc2 = document.getElementById('osc2-tab');

    if (btnOsc1 && btnOsc2 && paneOsc1 && paneOsc2) {
      btnOsc1.addEventListener('click', () => {
        btnOsc1.classList.add('active');
        btnOsc2.classList.remove('active');
        paneOsc1.style.display = 'flex';
        paneOsc2.style.display = 'none';
      });

      btnOsc2.addEventListener('click', () => {
        btnOsc2.classList.add('active');
        btnOsc1.classList.remove('active');
        paneOsc2.style.display = 'flex';
        paneOsc1.style.display = 'none';
      });
    }
  }

  // --- MPE Performance Controls & 2D Touchpad ---

  initPerformanceSection() {
    // MPE Bend Range Selector
    const bendSelect = document.getElementById('mpe-bend-range');
    if (bendSelect) {
      bendSelect.addEventListener('change', (e) => {
        const range = parseInt(e.target.value, 10);
        this.synth.params.mpePitchBendRange = range;
      });
    }

    // 2D Touchpad
    this.initTouchpad();

    // Toggle MIDI Monitor button (disabled by default for max performance)
    const btnToggleMidi = document.getElementById('btn-toggle-midi-log');
    const midiBadge = document.getElementById('midi-mon-badge');
    const tableWrap = document.getElementById('midi-log-table-wrap');
    const placeholder = document.getElementById('midi-log-placeholder');
    const btnClear = document.getElementById('btn-clear-log');

    if (btnClear) {
      btnClear.style.display = 'none'; // Hidden when monitor is paused
    }

    if (btnToggleMidi) {
      btnToggleMidi.addEventListener('click', () => {
        this.isMidiMonitorEnabled = !this.isMidiMonitorEnabled;
        if (this.isMidiMonitorEnabled) {
          if (tableWrap) tableWrap.style.display = 'block';
          if (placeholder) placeholder.style.display = 'none';
          if (btnClear) btnClear.style.display = 'inline-flex';
          btnToggleMidi.textContent = 'HIDE';
          if (midiBadge) {
            midiBadge.textContent = 'LIVE';
            midiBadge.classList.remove('badge-muted');
          }
        } else {
          if (tableWrap) tableWrap.style.display = 'none';
          if (placeholder) placeholder.style.display = 'none'; // Hide log area to save vertical space
          if (btnClear) btnClear.style.display = 'none';
          btnToggleMidi.textContent = 'SHOW';
          if (midiBadge) {
            midiBadge.textContent = 'PAUSED';
            midiBadge.classList.add('badge-muted');
          }
        }
      });
    }

    // Clear MIDI Log button
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        this.midiLogEntries = [];
        const tbody = document.getElementById('midi-log-body');
        if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="empty-log">Log cleared.</td></tr>';
      });
    }
  }

  initTouchpad() {
    const pad = document.getElementById('mpe-touchpad');
    const cursor = document.getElementById('touchpad-cursor');
    const status = document.getElementById('touchpad-status');
    let isTouching = false;
    const mpeChannel = 2; // Member channel 2
    const padNote = 60; // C4

    const updateTouch = (clientX, clientY) => {
      const rect = pad.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, clientY - rect.top));

      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;

      // Normalized coordinates
      const normX = (x / rect.width) * 2 - 1; // -1 to +1 (Bend)
      const normY = 1 - (y / rect.height); // 0 (bottom) to 1 (top) (CC74 Timbre)

      const bendVal = Math.round(8192 + normX * 8191);
      const cc74Val = Math.round(normY * 127);

      // Send MPE Bend and CC74 (Timbre) to member channel
      this.synth.setPitchBend(mpeChannel, bendVal);
      this.synth.setCC(mpeChannel, 74, cc74Val);

      // Live update filterCutoff UI slider and visualizer
      if (this.cutoffAnimFrame) {
        cancelAnimationFrame(this.cutoffAnimFrame);
        this.cutoffAnimFrame = null;
      }
      const minLog = Math.log(20);
      const maxLog = Math.log(20000);
      const rawHz = Math.exp(minLog + normY * (maxLog - minLog));
      const hz = rawHz < 100
        ? Math.round(rawHz / 2) * 2
        : rawHz < 300
          ? Math.round(rawHz / 10) * 10
          : Math.round(rawHz / 20) * 20;
      this.currentDisplayCutoff = hz;
      this.updateSliderUI('filterCutoff', hz, `${hz} Hz`);
      const readout = document.getElementById('filter-cutoff-readout');
      if (readout) readout.textContent = `${hz} Hz`;
      this.visualizer?.markFilterDirty();

      status.textContent = `X: Bend ${bendVal - 8192} | Y: CC74 ${cc74Val} | Gate: ON`;
    };

    const startTouch = (e) => {
      e.preventDefault();
      if (!this.synth.isAudioStarted) {
        document.getElementById('btn-audio-power').click();
      }
      isTouching = true;
      cursor.style.display = 'block';
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      updateTouch(clientX, clientY);
      this.synth.noteOn(padNote, 0.85, mpeChannel);
    };

    const moveTouch = (e) => {
      if (!isTouching) return;
      e.preventDefault();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      updateTouch(clientX, clientY);
    };

    const stopTouch = (e) => {
      if (!isTouching) return;
      isTouching = false;
      cursor.style.display = 'none';
      this.synth.noteOff(padNote, mpeChannel);
      // Reset bend
      this.synth.setPitchBend(mpeChannel, 8192);
      status.textContent = 'X: Bend 0 | Y: CC74 64 | Gate: OFF';
    };

    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { pad.setPointerCapture(e.pointerId); } catch (_) {}
      startTouch(e);
    });
    pad.addEventListener('pointermove', (e) => {
      if (isTouching) {
        e.preventDefault();
        moveTouch(e);
      }
    });
    pad.addEventListener('pointerup', (e) => {
      try { pad.releasePointerCapture(e.pointerId); } catch (_) {}
      stopTouch(e);
    });
    pad.addEventListener('pointercancel', stopTouch);
  }

  // --- MIDI Log ---

  addMidiLog(entry) {
    this.midiLogEntries.unshift(entry);
    if (this.midiLogEntries.length > 30) {
      this.midiLogEntries.pop();
    }

    const tbody = document.getElementById('midi-log-body');
    if (!tbody) return;

    tbody.innerHTML = this.midiLogEntries.map(e => `
      <tr>
        <td style="color:#64748b">${e.time || ''}</td>
        <td style="color:#06b6d4">Ch${e.channel}</td>
        <td><strong>${e.type}</strong></td>
        <td style="color:#f59e0b">${e.value}</td>
        <td style="color:#94a3b8">${e.detail}</td>
      </tr>
    `).join('');
  }

  // --- Virtual Keyboard ---

  buildKeyboard() {
    const keyboard = document.getElementById('synth-keyboard');
    keyboard.innerHTML = '';

    const notesCount = 22; // C to A (13 white keys, 9 black keys)
    const totalWhiteKeys = 13;
    const startNote = this.baseOctave * 12; // e.g. 48 for C3, 60 for C4

    const isBlackKey = [false, true, false, true, false, false, true, false, true, false, true, false];

    // Mapped computer keyboard keys for the 22 virtual keys:
    // White keys: Q W E R T Y U I O P [ ] \
    // Black keys: 2 3 5 6 7 9 0 = ⌫
    const computerKeyLabels = [
      'Q',  // C
      '2',  // C#
      'W',  // D
      '3',  // D#
      'E',  // E
      'R',  // F
      '5',  // F#
      'T',  // G
      '6',  // G#
      'Y',  // A
      '7',  // A#
      'U',  // B
      'I',  // C (+1 oct)
      '9',  // C#
      'O',  // D
      '0',  // D#
      'P',  // E
      '[',  // F
      '=',  // F#
      ']',  // G
      '⌫',  // G#
      '\\'  // A
    ];

    let whiteKeyIndex = 0;

    for (let i = 0; i < notesCount; i++) {
      const midiNote = startNote + i;
      const noteInOct = i % 12;
      const isBlack = isBlackKey[noteInOct];
      const keyChar = computerKeyLabels[i] || '';

      const key = document.createElement('div');
      key.dataset.note = midiNote;

      if (!isBlack) {
        key.className = 'key key-white';
        key.innerHTML = `<span class="key-label">${keyChar}</span>`;
        whiteKeyIndex++;
      } else {
        key.className = 'key key-black';
        // Center black key over boundary between preceding and next white key
        key.style.left = `calc(4px + ${(whiteKeyIndex / totalWhiteKeys)} * (100% - 8px))`;
        key.innerHTML = `<span class="key-label">${keyChar}</span>`;
      }

      const triggerNote = (e) => {
        e.preventDefault();
        if (!this.synth.isAudioStarted) {
          document.getElementById('btn-audio-power').click();
        }
        if (!this.activeMouseNotes.has(midiNote)) {
          this.activeMouseNotes.set(midiNote, true);
          this.synth.noteOn(midiNote, 0.8, 1);
          key.classList.add('active');
        }
      };

      const releaseNote = (e) => {
        if (this.activeMouseNotes.has(midiNote)) {
          this.activeMouseNotes.delete(midiNote);
          this.synth.noteOff(midiNote, 1);
          key.classList.remove('active');
        }
      };

      // Pointer events provide ultra-low latency on Android & touch devices
      key.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        triggerNote(e);
      });
      key.addEventListener('pointerenter', (e) => {
        if (e.buttons === 1) triggerNote(e);
      });
      key.addEventListener('pointerup', releaseNote);
      key.addEventListener('pointercancel', releaseNote);
      key.addEventListener('pointerleave', releaseNote);

      // Fallback for touch devices
      key.addEventListener('touchstart', (e) => {
        e.preventDefault();
        triggerNote(e);
      }, { passive: false });
      key.addEventListener('touchend', releaseNote);

      keyboard.appendChild(key);
    }

    // Octave Shift Buttons (bind once)
    if (!this._octaveButtonsBound) {
      this._octaveButtonsBound = true;
      document.getElementById('btn-oct-down')?.addEventListener('click', () => {
        if (this.baseOctave > 1) {
          this.baseOctave--;
          document.getElementById('current-octave-display').textContent = `C${this.baseOctave}`;
          this.buildKeyboard();
        }
      });

      document.getElementById('btn-oct-up')?.addEventListener('click', () => {
        if (this.baseOctave < 7) {
          this.baseOctave++;
          document.getElementById('current-octave-display').textContent = `C${this.baseOctave}`;
          this.buildKeyboard();
        }
      });
    }
  }

  bindComputerKeys() {
    const keyMap = {
      // White keys: Q W E R T Y U I O P [ ] \
      'q': 0,
      'w': 2,
      'e': 4,
      'r': 5,
      't': 7,
      'y': 9,
      'u': 11,
      'i': 12,
      'o': 14,
      'p': 16,
      '[': 17, '{': 17,
      ']': 19, '}': 19,
      '\\': 21, '|': 21,
      // Black keys: 2 3 5 6 7 9 0 = Backspace/Delete
      '2': 1, '@': 1,
      '3': 3, '#': 3,
      '5': 6, '%': 6,
      '6': 8, '^': 8,
      '7': 10, '&': 10,
      '9': 13, '(': 13,
      '0': 15, ')': 15,
      '=': 18, '+': 18,
      'backspace': 20,
      'delete': 20
    };

    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      const key = e.key.toLowerCase();
      if (key in keyMap) {
        e.preventDefault();
        if (!this.synth.isAudioStarted) {
          document.getElementById('btn-audio-power').click();
        }
        const offset = keyMap[key];
        const midiNote = this.baseOctave * 12 + offset;
        if (!this.activeKeyNotes.has(key)) {
          this.activeKeyNotes.set(key, midiNote);
          this.synth.noteOn(midiNote, 0.85, 1);
          const keyEl = document.querySelector(`.key[data-note="${midiNote}"]`);
          if (keyEl) keyEl.classList.add('active');
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      if (key in keyMap) {
        if (key === 'backspace' || key === 'delete') {
          e.preventDefault();
        }
        const offset = keyMap[key];
        for (const [activeKey, activeNote] of this.activeKeyNotes.entries()) {
          if (keyMap[activeKey] === offset) {
            this.activeKeyNotes.delete(activeKey);
            this.synth.noteOff(activeNote, 1);
            const keyEl = document.querySelector(`.key[data-note="${activeNote}"]`);
            if (keyEl) keyEl.classList.remove('active');
          }
        }
      }
    });
  }

  updateKeyboardHighlights(states) {
    const activeNotes = new Set();
    states.forEach(s => {
      if (s.isActive && !s.isReleasing) {
        activeNotes.add(s.note);
      }
    });

    this.activeMouseNotes.forEach((_, note) => activeNotes.add(note));
    this.activeKeyNotes.forEach((note) => activeNotes.add(note));

    document.querySelectorAll('.key').forEach(k => {
      const note = parseInt(k.dataset.note, 10);
      if (activeNotes.has(note)) {
        k.classList.add('active');
      } else {
        k.classList.remove('active');
      }
    });
  }

  clearKeyHighlights() {
    document.querySelectorAll('.key').forEach(k => k.classList.remove('active'));
  }

  midiNoteToName(midiNote) {
    if (midiNote === null || midiNote === undefined) return '-';
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor(midiNote / 12) - 1;
    const note = names[midiNote % 12];
    return `${note}${octave}`;
  }
}

// Instantiate and start UI when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  const ui = new SynthUI();
  window.synthUI = ui;
  ui.init();
});
