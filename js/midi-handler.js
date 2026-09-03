/**
 * MidiHandler: Integrates Web MIDI API and decodes standard & MPE messages.
 * Enhanced for Android Chrome, Secure Context detection, and explicit permission requests.
 */
export class MidiHandler {
  constructor(synthEngine) {
    this.synth = synthEngine;
    this.midiAccess = null;
    this.selectedInputId = 'all'; // 'all' or specific port ID
    this.inputs = [];
    this.onDeviceListChange = null;
    this.onMidiActivity = null; // Callback for UI MIDI event log / LED
    this.onStatusChange = null; // Callback to report status to UI
    this.sustainPedal = false;
    this.sustainedNotes = new Set();
    this.lastError = null;
  }

  /**
   * Checks browser support and secure context status.
   */
  checkEnvironment() {
    const isSecure = typeof window !== 'undefined' ? window.isSecureContext : false;
    const hasMidiApi = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
    return {
      isSecureContext: isSecure,
      hasMidiApi: hasMidiApi,
      isAndroid: /Android/i.test(navigator.userAgent || '')
    };
  }

  /**
   * Initializes or requests Web MIDI access.
   * Can be called on page load or upon user interaction (tap/click).
   */
  async requestAccess() {
    const env = this.checkEnvironment();

    if (!env.isSecureContext) {
      const msg = 'Web MIDI is disabled because this page is not served over HTTPS or localhost.';
      this.lastError = msg;
      this.reportStatus('insecure', msg);
      return { supported: false, isSecureContext: false, error: msg };
    }

    if (!env.hasMidiApi) {
      const msg = 'Web MIDI API is not supported in this browser.';
      this.lastError = msg;
      this.reportStatus('unsupported', msg);
      return { supported: false, isSecureContext: true, error: msg };
    }

    try {
      this.reportStatus('requesting', 'Requesting MIDI permissions...');

      // Try requesting standard MIDI first
      let access = null;
      try {
        access = await navigator.requestMIDIAccess({ sysex: false });
      } catch (err) {
        // Fallback without options object if first call failed
        access = await navigator.requestMIDIAccess();
      }

      this.midiAccess = access;
      this.lastError = null;

      this.updateDeviceList();

      // Listen for USB device connection / disconnection
      this.midiAccess.onstatechange = (event) => {
        this.updateDeviceList();
        const port = event.port;
        if (port && port.type === 'input') {
          this.reportStatus(
            port.state === 'connected' ? 'connected' : 'disconnected',
            `Device ${port.state}: ${port.name || port.id}`
          );
        }
      };

      this.bindInputs();

      const deviceCount = this.inputs.length;
      if (deviceCount > 0) {
        this.reportStatus('ready', `${deviceCount} MIDI device${deviceCount > 1 ? 's' : ''} connected`);
      } else {
        this.reportStatus('no_devices', 'MIDI ready. No devices detected (connect USB MIDI & tap Scan)');
      }

      return { supported: true, isSecureContext: true, inputs: this.inputs };
    } catch (err) {
      console.warn('Web MIDI access rejected or failed:', err);
      let userMsg = err.message || 'Permission denied';
      if (err.name === 'SecurityError') {
        userMsg = 'MIDI permission blocked by browser security policy.';
      } else if (err.name === 'NotAllowedError') {
        userMsg = 'MIDI permission denied by user or system prompt.';
      }
      this.lastError = userMsg;
      this.reportStatus('denied', userMsg);
      return { supported: false, isSecureContext: true, error: userMsg };
    }
  }

  reportStatus(state, message) {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange({
        state,
        message,
        deviceCount: this.inputs.length,
        isSecureContext: window.isSecureContext,
        isAndroid: /Android/i.test(navigator.userAgent || '')
      });
    }
  }

  updateDeviceList() {
    if (!this.midiAccess) return;

    this.inputs = [];
    for (const entry of this.midiAccess.inputs.values()) {
      this.inputs.push({
        id: entry.id,
        name: entry.name || `MIDI Device ${entry.id}`,
        manufacturer: entry.manufacturer || 'Generic',
        state: entry.state
      });
    }

    this.bindInputs();

    if (typeof this.onDeviceListChange === 'function') {
      this.onDeviceListChange(this.inputs);
    }
  }

  selectInput(inputId) {
    this.selectedInputId = inputId;
    this.bindInputs();
  }

  bindInputs() {
    if (!this.midiAccess) return;

    for (const input of this.midiAccess.inputs.values()) {
      // Detach previous handler
      input.onmidimessage = null;

      if (this.selectedInputId === 'all' || this.selectedInputId === input.id) {
        input.onmidimessage = (message) => this.handleMidiMessage(message, input.name);
      }
    }
  }

  handleMidiMessage(message, sourceName = '') {
    const [status, data1, data2] = message.data;
    const command = status >> 4;
    const channel = (status & 0x0F) + 1; // 1-indexed (1..16)

    let logEvent = null;

    switch (command) {
      case 0x9: { // Note On
        const note = data1;
        const velocity = data2 / 127;
        if (velocity > 0) {
          this.synth.noteOn(note, velocity, channel);
          logEvent = { type: 'Note On', channel, note, value: data2, detail: `Vel: ${data2}` };
        } else {
          // Velocity 0 is Note Off
          this.processNoteOff(note, channel);
          logEvent = { type: 'Note Off', channel, note, value: 0, detail: `Vel: 0` };
        }
        break;
      }

      case 0x8: { // Note Off
        const note = data1;
        this.processNoteOff(note, channel);
        logEvent = { type: 'Note Off', channel, note, value: data2, detail: `Release: ${data2}` };
        break;
      }

      case 0xB: { // Control Change
        const ccNumber = data1;
        const ccValue = data2;

        if (ccNumber === 64) {
          // Sustain Pedal
          this.sustainPedal = ccValue >= 64;
          if (!this.sustainPedal) {
            // Release all held sustained notes
            for (const item of this.sustainedNotes) {
              const [sNote, sChan] = item.split(':').map(Number);
              this.synth.noteOff(sNote, sChan);
            }
            this.sustainedNotes.clear();
          }
          logEvent = { type: 'Sustain (CC64)', channel, note: '-', value: ccValue, detail: this.sustainPedal ? 'ON' : 'OFF' };
        } else if (ccNumber === 120 || ccNumber === 123) {
          // All Sound Off / All Notes Off (Panic)
          this.synth.panic();
          this.sustainedNotes.clear();
          logEvent = { type: 'Panic / All Off', channel, note: '-', value: ccValue, detail: `CC ${ccNumber}` };
        } else {
          // Standard / MPE CC
          let desc = `CC ${ccNumber}`;
          if (ccNumber === 73) desc = 'CC73 (Cutoff)';
          if (ccNumber === 1) desc = 'CC1 (Resonance)';
          if (ccNumber === 11) desc = 'CC11 (Volume)';

          this.synth.setCC(channel, ccNumber, ccValue);
          logEvent = { type: desc, ccNumber, channel, note: '-', value: ccValue, detail: `Val: ${ccValue}` };
        }
        break;
      }

      case 0xE: { // Pitch Bend (14-bit)
        const lsb = data1;
        const msb = data2;
        const rawBend = (msb << 7) | lsb; // 0..16383 (center 8192)
        this.synth.setPitchBend(channel, rawBend);

        const bendOffset = rawBend - 8192;
        logEvent = { type: 'Pitch Bend', channel, note: '-', value: rawBend, detail: `${bendOffset >= 0 ? '+' : ''}${bendOffset}` };
        break;
      }

      case 0xD: { // Channel Pressure (Aftertouch)
        const pressure = data1;
        this.synth.setPressure(channel, pressure);
        logEvent = { type: 'Pressure', channel, note: '-', value: pressure, detail: `Val: ${pressure}` };
        break;
      }

      default:
        break;
    }

    if (logEvent && typeof this.onMidiActivity === 'function') {
      logEvent.time = new Date().toLocaleTimeString();
      logEvent.source = sourceName;
      this.onMidiActivity(logEvent);
    }
  }

  processNoteOff(note, channel) {
    if (this.sustainPedal) {
      this.sustainedNotes.add(`${note}:${channel}`);
    } else {
      this.synth.noteOff(note, channel);
    }
  }
}
