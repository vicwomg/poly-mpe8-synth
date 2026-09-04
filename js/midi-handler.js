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
    this.recentMessages = new Map(); // For deduplicating simultaneous packets across ports
    this.jsRxCount = 0;
    this.lastMidiEventStr = 'none';
    this.isCoreMidiListening = false;
    this.externalMidiListeners = new Set();

    if (typeof window !== 'undefined') {
      window.midisteelParentBridge = {
        isDeviceConnected: () => this.isMidiSteelConnected(),
        getDeviceName: () => this.getMidiSteelDeviceName(),
        sendMidi: (bytes, target) => this.sendMidi(bytes, target),
        subscribeMidi: (cb) => this.subscribeMidi(cb),
        unsubscribeMidi: (cb) => this.unsubscribeMidi(cb),
        getInputs: () => [...this.inputs],
        getNativeMidiAccess: () => this.midiAccess
      };
    }
  }

  /**
   * Dispatches incoming native CoreMIDI packets to synth engine.
   */
  handleCoreMidiEvent(detail) {
    if (!detail || !detail.data) return;
    this.jsRxCount++;

    const sourceId = detail.sourceId ? String(detail.sourceId) : '';
    const sourceName = detail.sourceName || 'CoreMIDI';

    // Auto resume Web Audio on incoming MIDI if suspended
    if (this.synth.ctx && this.synth.ctx.state === 'suspended') {
      this.synth.ctx.resume().catch(() => {});
    }

    // Filter by selectedInputId if a specific port is selected
    if (this.selectedInputId !== 'all' && sourceId && this.selectedInputId !== sourceId) {
      return;
    }

    const fakeEvent = {
      data: new Uint8Array(detail.data),
      timeStamp: detail.timestamp || performance.now()
    };
    this.handleMidiMessage(fakeEvent, sourceName);
  }

  /**
   * Retrieves or dynamically registers the Capacitor CoreMidiPlugin for iOS.
   */
  getCoreMidiPlugin() {
    if (typeof window === 'undefined' || !window.Capacitor) return null;
    if (window.Capacitor.Plugins?.CoreMidiPlugin) {
      return window.Capacitor.Plugins.CoreMidiPlugin;
    }
    if (typeof window.Capacitor.registerPlugin === 'function') {
      try {
        const reg = window.Capacitor.registerPlugin('CoreMidiPlugin');
        if (reg) return reg;
      } catch (err) {
        console.warn('Failed to register CoreMidiPlugin via registerPlugin:', err);
      }
    }
    // Direct native bridge proxy fallback for iOS Capacitor
    if (window.Capacitor.isNativePlatform?.() && window.Capacitor.getPlatform?.() === 'ios') {
      const pluginName = 'CoreMidiPlugin';
      return {
        listInputs: (opts) => window.Capacitor.nativePromise(pluginName, 'listInputs', opts || {}),
        scanInputs: (opts) => window.Capacitor.nativePromise(pluginName, 'scanInputs', opts || {}),
        listOutputs: (opts) => window.Capacitor.nativePromise(pluginName, 'listOutputs', opts || {}),
        sendMidi: (opts) => window.Capacitor.nativePromise(pluginName, 'sendMidi', opts || {}),
        getDiagnostics: (opts) => window.Capacitor.nativePromise(pluginName, 'getDiagnostics', opts || {}),
        addListener: (eventName, callback) => window.Capacitor.addListener(pluginName, eventName, callback),
        removeAllListeners: () => window.Capacitor.nativePromise(pluginName, 'removeAllListeners', {})
      };
    }
    return null;
  }

  /**
   * Checks browser support and secure context status.
   */
  checkEnvironment() {
    const isCapacitor = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform();
    const isIOS = isCapacitor && window.Capacitor?.getPlatform?.() === 'ios';
    const coreMidi = isCapacitor ? this.getCoreMidiPlugin() : null;
    const hasCoreMidiPlugin = !!coreMidi;
    const isSecure = typeof window !== 'undefined' ? window.isSecureContext : false;
    const hasMidiApi = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
    return {
      isSecureContext: isSecure || isCapacitor,
      hasMidiApi: hasMidiApi || hasCoreMidiPlugin || isIOS,
      hasCoreMidiPlugin,
      isCapacitor,
      isIOS,
      isAndroid: typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '')
    };
  }

  /**
   * Prioritizes hardware / USB MIDI devices over virtual network sessions.
   */
  getPreferredInputId(inputs) {
    if (!inputs || inputs.length === 0) return 'all';

    const isVirtual = (d) => {
      const n = (d.name || '').toLowerCase();
      return d.isNetwork || n.includes('network session') || n.includes('session ') || n.includes('rtpmidi') || n.includes('network');
    };

    const hardwareDevices = inputs.filter(d => !isVirtual(d));
    if (hardwareDevices.length > 0) {
      // Pick the first physical hardware controller (e.g. Teensy MIDI)
      return hardwareDevices[0].id;
    }

    return inputs[0].id;
  }

  /**
   * Initializes or requests Web MIDI or native CoreMIDI access.
   * Can be called on page load or upon user interaction (tap/click).
   */
  async requestAccess() {
    const env = this.checkEnvironment();

    // 1. Native iOS CoreMIDI Bridge
    if (env.isIOS || env.hasCoreMidiPlugin) {
      const coreMidi = this.getCoreMidiPlugin();
      if (!coreMidi) {
        const msg = 'CoreMIDI plugin is not available on this iOS build.';
        this.lastError = msg;
        this.reportStatus('unsupported', msg);
        return { supported: false, isSecureContext: true, error: msg };
      }

      try {
        if (typeof coreMidi.scanInputs === 'function') {
          await coreMidi.scanInputs().catch(() => {});
        }
        const res = await coreMidi.listInputs();
        this.inputs = (res.inputs || []).map(d => ({
          id: d.id,
          name: d.name,
          isNetwork: d.isNetwork,
          manufacturer: 'Apple CoreMIDI',
          state: 'connected'
        }));

        // Prioritize hardware controller over virtual network sessions
        if (this.selectedInputId === 'all' || !this.inputs.some(d => d.id === this.selectedInputId)) {
          this.selectedInputId = this.getPreferredInputId(this.inputs);
        }

        // Set up CoreMIDI event listeners once
        if (!this.isCoreMidiListening) {
          this.isCoreMidiListening = true;

          // 1a. Direct WebKit Custom Event (Primary, ultra-fast, zero-overhead)
          window.addEventListener('coremidimessage', (event) => {
            if (event && event.detail) {
              this.handleCoreMidiEvent(event.detail);
            }
          });

          // 1b. Capacitor Plugin Listener (Secondary bridge channel)
          coreMidi.addListener('midiMessage', (event) => {
            if (event && event.data) {
              this.handleCoreMidiEvent(event);
            }
          });

          coreMidi.addListener('devicesChanged', (event) => {
            this.inputs = (event.inputs || []).map(d => ({
              id: d.id,
              name: d.name,
              isNetwork: d.isNetwork,
              manufacturer: 'Apple CoreMIDI',
              state: 'connected'
            }));
            if (this.selectedInputId === 'all' || !this.inputs.some(d => d.id === this.selectedInputId)) {
              this.selectedInputId = this.getPreferredInputId(this.inputs);
            }
            if (this.onDeviceListChange) {
              this.onDeviceListChange(this.inputs, this.selectedInputId);
            }
            const count = this.inputs.length;
            if (count > 0) {
              this.reportStatus('ready', `${count} CoreMIDI device(s) connected`);
            } else {
              this.reportStatus('no_devices', 'CoreMIDI ready. Connect a MIDI controller.');
            }
          });
        }

        this.midiAccess = { isCoreMidi: true };
        const deviceCount = this.inputs.length;
        if (deviceCount > 0) {
          this.reportStatus('ready', `${deviceCount} CoreMIDI device(s) connected`);
        } else {
          this.reportStatus('no_devices', 'CoreMIDI ready. Connect a MIDI controller.');
        }
        if (this.onDeviceListChange) {
          this.onDeviceListChange(this.inputs, this.selectedInputId);
        }
        return { supported: true, isSecureContext: true, inputs: this.inputs };
      } catch (err) {
        console.warn('CoreMIDI plugin initialization failed:', err);
        const userMsg = err.message || 'Failed to initialize CoreMIDI.';
        this.lastError = userMsg;
        this.reportStatus('error', userMsg);
        return { supported: false, isSecureContext: true, error: userMsg };
      }
    }

    if (!env.isSecureContext) {
      const msg = 'Web MIDI is disabled because this page is not served over HTTPS or localhost.';
      this.lastError = msg;
      this.reportStatus('insecure', msg);
      return { supported: false, isSecureContext: false, error: msg };
    }

    if (!env.hasMidiApi || typeof navigator?.requestMIDIAccess !== 'function') {
      const msg = 'Web MIDI API is not supported in this browser.';
      this.lastError = msg;
      this.reportStatus('unsupported', msg);
      return { supported: false, isSecureContext: true, error: msg };
    }

    try {
      this.reportStatus('requesting', 'Requesting MIDI permissions...');

      // Request MIDI with sysex support for controller bidirectional configuration
      let access = null;
      try {
        access = await navigator.requestMIDIAccess({ sysex: true });
      } catch (err) {
        try {
          access = await navigator.requestMIDIAccess({ sysex: false });
        } catch (err2) {
          access = await navigator.requestMIDIAccess();
        }
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

    // Prioritize physical hardware devices over virtual sessions
    if (this.selectedInputId === 'all' || !this.inputs.some(d => d.id === this.selectedInputId)) {
      this.selectedInputId = this.getPreferredInputId(this.inputs);
    }

    this.bindInputs();

    if (typeof this.onDeviceListChange === 'function') {
      this.onDeviceListChange(this.inputs, this.selectedInputId);
    }
  }

  selectInput(inputId) {
    this.selectedInputId = inputId;
    this.bindInputs();
  }

  bindInputs() {
    if (!this.midiAccess || this.midiAccess.isCoreMidi) return;

    for (const input of this.midiAccess.inputs.values()) {
      // Detach previous handler
      input.onmidimessage = null;

      if (this.selectedInputId === 'all' || this.selectedInputId === input.id) {
        input.onmidimessage = (message) => this.handleMidiMessage(message, input.name);
      }
    }
  }

  handleMidiMessage(message, sourceName = '') {
    if (!message || !message.data || message.data.length === 0) return;

    // Broadcast raw incoming message to any external subscribers (such as MIDISteel settings)
    if (this.externalMidiListeners && this.externalMidiListeners.size > 0) {
      const rawBytes = message.data instanceof Uint8Array ? message.data : new Uint8Array(message.data);
      for (const cb of this.externalMidiListeners) {
        try { cb(rawBytes, sourceName); } catch (e) { console.error('Error in external MIDI listener:', e); }
      }
    }

    let offset = 0;
    while (offset < message.data.length) {
      const status = message.data[offset];
      if (status < 0x80) {
        // Skip stray non-status bytes
        offset++;
        continue;
      }

      const command = status >> 4;
      const channel = (status & 0x0F) + 1; // 1-indexed (1..16)

      let msgLength = 1;
      if (command === 0xC || command === 0xD) {
        // Program Change, Channel Pressure (1 data byte)
        msgLength = 2;
      } else if ((command >= 0x8 && command <= 0xB) || command === 0xE) {
        // Note Off, Note On, Poly Pressure, CC, Pitch Bend (2 data bytes)
        msgLength = 3;
      } else if (status === 0xF0) {
        // SysEx: advance until 0xF7 or end
        let end = offset + 1;
        while (end < message.data.length && message.data[end] !== 0xF7) {
          end++;
        }
        if (end < message.data.length && message.data[end] === 0xF7) {
          end++;
        }
        offset = end;
        continue;
      }

      const data1 = offset + 1 < message.data.length ? message.data[offset + 1] : 0;
      const data2 = offset + 2 < message.data.length ? message.data[offset + 2] : 0;

      this.processSingleMidiMessage(command, channel, data1, data2, sourceName);
      offset += msgLength;
    }
  }

  processSingleMidiMessage(command, channel, data1, data2, sourceName) {
    // Deduplicate identical MIDI packets arriving simultaneously across endpoints (common on Android USB MIDI)
    const now = performance.now();
    const dedupeKey = `${command}:${channel}:${data1}:${(command === 0x9 || command === 0x8) ? '' : data2}`;
    const lastTime = this.recentMessages.get(dedupeKey);
    if (lastTime && (now - lastTime) < 20) {
      // Discard duplicate packet arriving within 20ms
      return;
    }
    this.recentMessages.set(dedupeKey, now);

    // Housekeep dedupe map
    if (this.recentMessages.size > 50) {
      for (const [k, ts] of this.recentMessages) {
        if (now - ts > 250) this.recentMessages.delete(k);
      }
    }

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
      this.lastMidiEventStr = `${logEvent.type} Ch${channel} ${logEvent.note !== '-' ? 'Note:' + logEvent.note : ''} ${logEvent.detail || ''}`;
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

  async getDiagnostics() {
    const env = this.checkEnvironment();
    const coreMidi = this.getCoreMidiPlugin();
    const result = {
      isCapacitor: env.isCapacitor,
      isIOS: env.isIOS,
      isAndroid: env.isAndroid,
      isSecureContext: env.isSecureContext,
      hasMidiApi: env.hasMidiApi,
      hasCoreMidiPlugin: !!coreMidi,
      capacitorPlugins: typeof window !== 'undefined' && window.Capacitor?.Plugins ? Object.keys(window.Capacitor.Plugins) : [],
      selectedInputId: this.selectedInputId,
      cachedInputs: this.inputs,
      jsRxPacketCount: this.jsRxCount,
      lastMidiEvent: this.lastMidiEventStr,
      audioContextState: this.synth.ctx ? this.synth.ctx.state : 'uninitialized',
      nativeDiagnostics: null
    };

    if (coreMidi && typeof coreMidi.getDiagnostics === 'function') {
      try {
        result.nativeDiagnostics = await coreMidi.getDiagnostics();
      } catch (err) {
        result.nativeDiagnostics = { error: err.message || String(err) };
      }
    }

    return result;
  }

  /**
   * Subscribes an external listener to all incoming raw MIDI byte arrays.
   */
  subscribeMidi(callback) {
    if (typeof callback === 'function') {
      this.externalMidiListeners.add(callback);
    }
  }

  /**
   * Removes an external listener.
   */
  unsubscribeMidi(callback) {
    this.externalMidiListeners.delete(callback);
  }

  /**
   * Checks whether a connected device is named "MIDISteel" (case-insensitive, flexible spacing/hyphens).
   */
  isMidiSteelConnected(inputs = this.inputs) {
    const pattern = /midi[-_\s]?steel|lap[-_\s]?steel/i;
    const list = inputs && inputs.length > 0 ? inputs : this.inputs;
    if (list && list.some(d => pattern.test(d.name || '') || pattern.test(d.manufacturer || '') || pattern.test(d.id || ''))) {
      return true;
    }
    // Also check raw midiAccess.inputs if cached list has not been populated yet
    if (this.midiAccess && this.midiAccess.inputs) {
      for (const entry of this.midiAccess.inputs.values()) {
        if (pattern.test(entry.name || '') || pattern.test(entry.manufacturer || '') || pattern.test(entry.id || '')) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Returns the display name of the connected MIDISteel device.
   */
  getMidiSteelDeviceName() {
    const pattern = /midi[-_\s]?steel|lap[-_\s]?steel/i;
    const check = (d) => pattern.test(`${d.name || ''} ${d.manufacturer || ''} ${d.id || ''}`);
    let dev = this.inputs.find(check);
    if (!dev && this.midiAccess?.inputs) {
      dev = Array.from(this.midiAccess.inputs.values()).find(check);
    }
    return dev ? (dev.name || 'MIDISteel') : 'MIDISteel';
  }

  /**
   * Transmits raw MIDI / SysEx bytes to connected hardware output port.
   * Works on iOS Native via CoreMIDI or via WebMIDI API.
   */
  async sendMidi(bytes, targetNameOrId = null) {
    const dataArray = Array.isArray(bytes) ? bytes : Array.from(bytes);
    const env = this.checkEnvironment();

    // 1. Native iOS CoreMIDI Output
    if (env.isIOS || env.hasCoreMidiPlugin) {
      const coreMidi = this.getCoreMidiPlugin();
      if (coreMidi && typeof coreMidi.sendMidi === 'function') {
        try {
          return await coreMidi.sendMidi({
            data: dataArray,
            destinationName: targetNameOrId,
            destinationId: targetNameOrId
          });
        } catch (err) {
          console.warn('CoreMidiPlugin.sendMidi error:', err);
          return { success: false, error: err.message };
        }
      }
    }

    // 2. Web MIDI API Output
    if (this.midiAccess && this.midiAccess.outputs) {
      let targetOutput = null;
      const outputs = Array.from(this.midiAccess.outputs.values());
      if (targetNameOrId) {
        targetOutput = outputs.find(o => o.id === targetNameOrId || (o.name && o.name.toLowerCase().includes(targetNameOrId.toLowerCase())));
      }
      if (!targetOutput) {
        targetOutput = outputs.find(o => /midisteel|teensy/i.test(o.name || '')) || outputs[0];
      }
      if (targetOutput && typeof targetOutput.send === 'function') {
        try {
          targetOutput.send(dataArray);
          return { success: true };
        } catch (err) {
          console.warn('WebMIDI output.send error:', err);
          return { success: false, error: err.message };
        }
      }
    }

    console.warn('sendMidi: No active MIDI output destination found');
    return { success: false, error: 'No MIDI output available' };
  }
}
