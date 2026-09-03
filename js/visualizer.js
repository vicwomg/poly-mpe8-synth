/**
 * Visualizer: Draws real-time audio oscilloscope and interactive filter frequency response.
 * Optimized for mobile with automatic disabling, event-driven filter drawing, and low CPU usage.
 */
export class Visualizer {
  constructor(synthEngine, oscilloscopeCanvasId, filterCanvasId) {
    this.synth = synthEngine;
    this.oscCanvas = document.getElementById(oscilloscopeCanvasId);
    this.filterCanvas = document.getElementById(filterCanvasId);

    if (this.oscCanvas) this.oscCtx = this.oscCanvas.getContext('2d');
    if (this.filterCanvas) this.filterCtx = this.filterCanvas.getContext('2d');

    this.isRunning = false;
    this.isMobile = (typeof window !== 'undefined') && (
      window.innerWidth <= 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
    );

    // Oscilloscope enabled state: enabled by default across all devices
    this.isOscilloscopeEnabled = true;

    // Filter redraw flag: only redraw when parameters actually change
    this.needsFilterRedraw = true;

    // Filter frequency points (log spaced 20 Hz to 20,000 Hz)
    this.numFilterPoints = 120; // Optimized from 180 to 120 for smoother mobile performance
    this.freqs = new Float32Array(this.numFilterPoints);
    this.magResponse = new Float32Array(this.numFilterPoints);
    this.phaseResponse = new Float32Array(this.numFilterPoints);

    const minFreq = 20;
    const maxFreq = 20000;
    for (let i = 0; i < this.numFilterPoints; i++) {
      this.freqs[i] = minFreq * Math.pow(maxFreq / minFreq, i / (this.numFilterPoints - 1));
    }

    this.mockFilter = null;
    this.lastFrameTime = 0;
    this.targetFps = this.isMobile ? 30 : 60;
    this.frameInterval = 1000 / this.targetFps;
  }

  setOscilloscopeEnabled(enabled) {
    this.isOscilloscopeEnabled = enabled;
    if (!enabled && this.oscCtx && this.oscCanvas) {
      // Clear canvas when disabled
      this.oscCtx.fillStyle = '#0f141d';
      this.oscCtx.fillRect(0, 0, this.oscCanvas.width, this.oscCanvas.height);
    }
  }

  markFilterDirty() {
    this.needsFilterRedraw = true;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.needsFilterRedraw = true;
    this.renderLoop();
  }

  stop() {
    this.isRunning = false;
  }

  renderLoop(timestamp = performance.now()) {
    if (!this.isRunning) return;

    const elapsed = timestamp - this.lastFrameTime;

    if (elapsed >= this.frameInterval) {
      this.lastFrameTime = timestamp - (elapsed % this.frameInterval);

      if (this.isOscilloscopeEnabled) {
        this.drawOscilloscope();
      }

      if (this.needsFilterRedraw) {
        this.drawFilterResponse();
        this.needsFilterRedraw = false;
      }
    }

    requestAnimationFrame((ts) => this.renderLoop(ts));
  }

  drawOscilloscope() {
    if (!this.oscCanvas || !this.oscCtx) return;
    const canvas = this.oscCanvas;
    const ctx = this.oscCtx;
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#0f141d';
    ctx.fillRect(0, 0, width, height);

    // Subtle grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = height / 4; y < height; y += height / 4) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    for (let x = width / 6; x < width; x += width / 6) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    ctx.stroke();

    if (!this.synth.analyser) {
      // Idle line
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      return;
    }

    const bufferLength = Math.min(512, this.synth.analyser.frequencyBinCount); // 512 points is plenty and 4x faster
    const dataArray = new Uint8Array(bufferLength);
    this.synth.analyser.getByteTimeDomainData(dataArray);

    // Fast glow without expensive shadowBlur (which forces CPU rasterization on mobile)
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#38bdf8';
    ctx.beginPath();

    const sliceWidth = width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0; // 0 to 2
      const y = (v * height) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.stroke();
  }

  drawFilterResponse() {
    if (!this.filterCanvas || !this.filterCtx || !this.synth.ctx) return;
    const canvas = this.filterCanvas;
    const ctx = this.filterCtx;
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#0f141d';
    ctx.fillRect(0, 0, width, height);

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const markFreqs = [100, 1000, 10000];
    for (const f of markFreqs) {
      const x = (Math.log10(f / 20) / Math.log10(20000 / 20)) * width;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    ctx.stroke();

    // Frequency labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = '10px monospace';
    ctx.fillText('100Hz', (Math.log10(100 / 20) / Math.log10(1000)) * width - 15, height - 6);
    ctx.fillText('1kHz', (Math.log10(1000 / 20) / Math.log10(1000)) * width - 12, height - 6);
    ctx.fillText('10kHz', (Math.log10(10000 / 20) / Math.log10(1000)) * width - 15, height - 6);

    if (!this.mockFilter) {
      this.mockFilter = this.synth.ctx.createBiquadFilter();
      this.mockFilter.type = 'lowpass';
    }

    // Effective cutoff considering global base + CC73
    const baseCutoff = this.synth.params.filterCutoff || 2000;
    const cc73Octaves = ((this.synth.globalCC73 - 64) / 64) * 3.5;
    const effectiveCutoff = Math.max(20, Math.min(20000, baseCutoff * Math.pow(2, cc73Octaves)));

    // Resonance Q considering base + CC1 (Mod Wheel)
    const baseQ = this.synth.params.filterResonance !== undefined ? this.synth.params.filterResonance : 1.0;
    const modWheelQ = (this.synth.globalCC1 / 127) * 18;
    const effectiveQ = Math.max(0.1, Math.min(25, baseQ + modWheelQ));

    this.mockFilter.frequency.setValueAtTime(effectiveCutoff, this.synth.ctx.currentTime);
    this.mockFilter.Q.setValueAtTime(effectiveQ, this.synth.ctx.currentTime);

    this.mockFilter.getFrequencyResponse(this.freqs, this.magResponse, this.phaseResponse);

    // Draw curve without shadowBlur overhead
    ctx.beginPath();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;

    for (let i = 0; i < this.numFilterPoints; i++) {
      const freq = this.freqs[i];
      const mag = this.magResponse[i];
      const db = 20 * Math.log10(Math.max(0.001, mag));

      const minDb = -36;
      const maxDb = 24;
      const y = height - ((db - minDb) / (maxDb - minDb)) * height;
      const x = (Math.log10(freq / 20) / Math.log10(20000 / 20)) * width;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Fill under curve
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
    ctx.fill();

    // Mark cutoff point
    const cutoffX = (Math.log10(effectiveCutoff / 20) / Math.log10(20000 / 20)) * width;
    ctx.strokeStyle = '#fbbf24';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cutoffX, 0);
    ctx.lineTo(cutoffX, height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Cutoff badge
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(`${Math.round(effectiveCutoff)} Hz (Q: ${effectiveQ.toFixed(1)})`, Math.max(6, Math.min(width - 120, cutoffX + 5)), 16);
  }
}
