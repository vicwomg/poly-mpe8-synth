/**
 * js/midisteel-bridge.js
 * Portable bridge adapter that allows midisteel_settings.html to seamlessly
 * re-use the host app's WebMIDI or native iOS CoreMIDI connection.
 * 
 * In standalone mode (opened directly in a browser without the synth host),
 * this script does nothing, preserving standard WebMIDI/WebSerial behavior.
 */
(function() {
  const parentBridge = (typeof window !== 'undefined' && window.parent && window.parent !== window) 
    ? window.parent.midisteelParentBridge 
    : null;

  if (!parentBridge) {
    // Running standalone: do not interfere with native APIs
    return;
  }

  const deviceId = 'midisteel-bridged-endpoint';
  let activeListeners = new Set();
  let bridgedInput = null;

  // Subscribe to host MIDI messages immediately
  parentBridge.subscribeMidi((data, sourceName) => {
    if (!bridgedInput) return;
    const bytes = (data instanceof Uint8Array) ? data : new Uint8Array(data);
    const fakeEvent = {
      data: bytes,
      timeStamp: performance.now(),
      target: bridgedInput
    };

    if (typeof bridgedInput._onmidimessage === 'function') {
      try {
        bridgedInput._onmidimessage(fakeEvent);
      } catch (err) {
        console.error('[MIDISteel Bridge] Error in onmidimessage handler:', err);
      }
    }

    activeListeners.forEach(listener => {
      try {
        listener(fakeEvent);
      } catch (err) {
        console.error('[MIDISteel Bridge] Error in midimessage event listener:', err);
      }
    });
  });

  // Polyfill / Override navigator.requestMIDIAccess so midisteel_settings.html connects through parent bridge
  if (typeof navigator !== 'undefined') {
    navigator.requestMIDIAccess = async function(options) {
      const deviceName = parentBridge.getDeviceName() || 'MIDISteel Controller';

      bridgedInput = {
        id: deviceId,
        name: deviceName,
        manufacturer: 'MIDISteel',
        state: 'connected',
        type: 'input',
        connection: 'open',
        _onmidimessage: null,
        get onmidimessage() {
          return this._onmidimessage;
        },
        set onmidimessage(fn) {
          this._onmidimessage = fn;
        },
        addEventListener(type, fn) {
          if (type === 'midimessage' && typeof fn === 'function') {
            activeListeners.add(fn);
          }
        },
        removeEventListener(type, fn) {
          if (type === 'midimessage') {
            activeListeners.delete(fn);
          }
        }
      };

      const bridgedOutput = {
        id: deviceId,
        name: deviceName,
        manufacturer: 'MIDISteel',
        state: 'connected',
        type: 'output',
        connection: 'open',
        send(data, timestamp) {
          const bytes = Array.isArray(data) ? data : Array.from(data);
          parentBridge.sendMidi(bytes, 'midisteel');
        }
      };

      const inputsMap = new Map([[deviceId, bridgedInput]]);
      const outputsMap = new Map([[deviceId, bridgedOutput]]);

      return {
        inputs: inputsMap,
        outputs: outputsMap,
        sysexEnabled: true,
        onstatechange: null,
        addEventListener: () => {},
        removeEventListener: () => {}
      };
    };
  }

  // Inject full-width responsive and scroll styling when embedded in synth iframe
  const injectLayoutStyles = () => {
    if (typeof document === 'undefined') return;
    if (document.getElementById('midisteel-bridge-layout-styles')) return;
    const style = document.createElement('style');
    style.id = 'midisteel-bridge-layout-styles';
    style.textContent = `
      html, body {
        width: 100% !important;
        max-width: 100% !important;
        min-height: 100% !important;
        box-sizing: border-box !important;
        overflow-x: hidden !important;
        overflow-y: auto !important;
        -webkit-overflow-scrolling: touch !important;
      }
      body {
        padding: 16px 20px 100px 20px !important;
      }
      header, .toolbar, .nav-tabs, #settingsBlocks, .tab-panel {
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
      }
      .ctrl-panel {
        display: grid !important;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)) !important;
        gap: 14px 18px !important;
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
      }
      .ctrl-panel h2 {
        grid-column: 1 / -1 !important;
        width: 100% !important;
      }
      .ctrl-field {
        flex: none !important;
        min-width: 0 !important;
        max-width: 100% !important;
        width: 100% !important;
        box-sizing: border-box !important;
      }
      .ctrl-field.full-width {
        grid-column: 1 / -1 !important;
        width: 100% !important;
      }
      .seg-toggle {
        display: flex !important;
        width: 100% !important;
      }
      .seg-toggle button {
        flex: 1 1 0 !important;
        min-width: 0 !important;
        padding-left: 6px !important;
        padding-right: 6px !important;
      }
      .ctrl-row {
        width: 100% !important;
      }
      .ctrl-row input {
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
      }
      .grid-wrapper {
        width: 100% !important;
        max-width: 100% !important;
      }
      .settings-actions {
        width: 100% !important;
        max-width: 100% !important;
        padding-bottom: 24px !important;
      }
    `;
    const target = document.head || document.documentElement;
    if (target) {
      target.appendChild(style);
    }
  };

  // Try immediate injection
  injectLayoutStyles();

  // DOM Enhancements when embedded inside the synth modal
  const onReady = () => {
    injectLayoutStyles();

    // Hide unsupported browser note if present (since bridge handles native iOS CoreMIDI)
    const browserNote = document.getElementById('browserNote');
    if (browserNote) {
      browserNote.style.display = 'none';
    }

    // Auto-click "Connect" button after UI initializes
    setTimeout(() => {
      const btnConnect = document.getElementById('btnConnect');
      if (btnConnect && !btnConnect.classList.contains('connected')) {
        btnConnect.click();
      }
    }, 250);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
