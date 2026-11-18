/**
 * MedSafe — scanning
 *   Camera: vendored html5-qrcode 2.3.8 (ZXing) — EAN-13, EAN-8, Code128, QR, DataMatrix.
 *           Back camera, torch toggle when the camera supports it, beep + vibrate on success.
 *   USB scanner: global listener — fast keystrokes ending in Enter are treated as one scan, on any screen.
 */
(function (root) {
  'use strict';

  let cam = null;          // Html5Qrcode instance
  let busy = false;
  let torchOn = false;

  function lib() { return root.__Html5QrcodeLibrary__ || {}; }

  function formats() {
    const F = lib().Html5QrcodeSupportedFormats;
    return [F.EAN_13, F.EAN_8, F.CODE_128, F.QR_CODE, F.DATA_MATRIX];
  }

  let audio = null;
  function beep() {
    try {
      audio = audio || new (root.AudioContext || root.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = 1760;
      g.gain.setValueAtTime(0.15, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.13);
    } catch (e) { /* sound is optional */ }
    if (navigator.vibrate) navigator.vibrate(80);
  }

  /**
   * Start the camera inside element #regionId. onResult(text) fires once, then the camera stops.
   * onTorch(supported) tells the UI whether to show the torch button.
   */
  async function open(regionId, onResult, onTorch) {
    if (!root.isSecureContext) throw new Error('camera needs https (GitHub Pages) or http://localhost');
    const L = lib();
    if (!L.Html5Qrcode) throw new Error('scanner library not loaded');
    await close();
    cam = new L.Html5Qrcode(regionId, { formatsToSupport: formats(), verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
    busy = false;
    torchOn = false;
    const config = {
      fps: 12,
      qrbox: function (w, h) { return { width: Math.floor(Math.min(w * 0.85, 340)), height: Math.floor(Math.min(h * 0.6, 220)) }; }
    };
    await cam.start({ facingMode: 'environment' }, config, function (text) {
      if (busy) return;
      busy = true;
      beep();
      close().then(function () { onResult(text); });
    }, function () { /* no code in this frame */ });
    let supported = false;
    try { supported = cam.getRunningTrackCameraCapabilities().torchFeature().isSupported(); } catch (e) { supported = false; }
    if (onTorch) onTorch(supported);
  }

  async function toggleTorch() {
    if (!cam) return false;
    try {
      torchOn = !torchOn;
      await cam.getRunningTrackCameraCapabilities().torchFeature().apply(torchOn);
    } catch (e) { torchOn = false; }
    return torchOn;
  }

  async function close() {
    const c = cam;
    cam = null;
    if (!c) return;
    try { if (c.isScanning) await c.stop(); } catch (e) { /* already stopped */ }
    try { c.clear(); } catch (e) { /* nothing to clear */ }
  }

  /**
   * USB / Bluetooth keyboard-wedge scanners type very fast and press Enter.
   * Keys < 50 ms apart, at least 6 characters, ending in Enter → onScan(code).
   * Typing into a normal field is left alone, except the product search box (scans go to the router).
   */
  function listenUsb(onScan, allowInField) {
    let buf = '', last = 0, gaps = [];
    document.addEventListener('keydown', function (e) {
      const t = e.target;
      const editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (editable && !(allowInField && allowInField(t))) { buf = ''; return; }
      const now = performance.now();
      if (e.key === 'Enter') {
        const fast = buf.length >= 6 && gaps.length && gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length < 50;
        if (fast) {
          e.preventDefault();
          const code = buf;
          buf = ''; gaps = [];
          if (editable) t.value = '';
          onScan(code);
        }
        buf = ''; gaps = [];
        return;
      }
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
      if (buf && now - last > 100) { buf = ''; gaps = []; }
      if (buf) gaps.push(now - last);
      buf += e.key;
      last = now;
    }, true);
  }

  root.Scanner = { open: open, close: close, toggleTorch: toggleTorch, listenUsb: listenUsb, beep: beep };
})(this);
