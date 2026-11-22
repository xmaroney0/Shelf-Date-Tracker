// Live barcode scanning with the phone camera.
//
// How it reads reliably:
// - Asks for a high-resolution camera feed with continuous focus.
// - Each try looks at the area inside the white frame (enlarged, so small barcodes get
//   more pixels), and every other try looks at the whole picture.
// - Uses "try harder" mode, which also reads sideways barcodes (common on milk jugs).
// - Android Chrome's built-in detector runs alongside when available.
// - 2x zoom lets you hold the phone farther back, where the camera can focus.
const ZXING_URL = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
let zxingPromise = null;
function loadZXing() {
  if (window.ZXing) return Promise.resolve();
  return (zxingPromise ||= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = ZXING_URL; s.onload = res;
    s.onerror = () => { zxingPromise = null; rej(new Error("Couldn't load the scanner. Check your connection.")); };
    document.head.appendChild(s);
  }));
}

const FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8", "code_128"];
let nativeDetector; // undefined = not checked yet, null = not available
async function getNativeDetector() {
  if (nativeDetector !== undefined) return nativeDetector;
  nativeDetector = null;
  if ("BarcodeDetector" in window) {
    try {
      const sup = await BarcodeDetector.getSupportedFormats();
      const use = FORMATS.filter((f) => sup.includes(f));
      if (use.length) nativeDetector = new BarcodeDetector({ formats: use });
    } catch (e) {}
  }
  return nativeDetector;
}

function makeZXingReader() {
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E, ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.CODE_128]);
  const r = new ZXing.MultiFormatReader();
  r.setHints(hints);
  return r;
}

// Opens a full-screen camera view. Resolves with the code, null if cancelled,
// or "" if the person chose to type the number instead.
export function scanBarcode() {
  return new Promise(async (resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "scanner";
    wrap.innerHTML = `<video playsinline muted autoplay></video><div class="scan-frame" aria-hidden="true"></div>
      <div class="scan-top"><button class="btn zoom" type="button" hidden>2×</button></div>
      <div class="scan-bar"><p class="scan-msg">Fit the barcode inside the box. Hold about 6 inches away.</p>
        <div class="scan-btns">
          <button class="btn torch" type="button" aria-pressed="false" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg><span>Flash</span></button>
          <button class="btn type" type="button">Type it</button>
          <button class="btn cancel" type="button">Cancel</button></div></div>`;
    document.body.appendChild(wrap);
    const video = wrap.querySelector("video");
    const msg = wrap.querySelector(".scan-msg");
    const torchBtn = wrap.querySelector(".torch");
    const zoomBtn = wrap.querySelector(".zoom");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let stream = null, done = false, timer = 0, torchOn = false, zoomed = false, tries = 0, zoomRange = null;
    const track = () => (stream ? stream.getVideoTracks()[0] : null);

    const finish = (code) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { const t = track(); if (torchOn && t) t.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {}); } catch (e) {}
      if (stream) stream.getTracks().forEach((t) => t.stop());
      wrap.remove();
      if (code && navigator.vibrate) navigator.vibrate(60);
      resolve(code == null ? null : code);
    };
    wrap.querySelector(".cancel").onclick = () => finish(null);
    wrap.querySelector(".type").onclick = () => finish("");

    torchBtn.onclick = async () => {
      const t = track(); if (!t) return;
      try {
        await t.applyConstraints({ advanced: [{ torch: !torchOn }] });
        torchOn = !torchOn;
        torchBtn.setAttribute("aria-pressed", String(torchOn));
        torchBtn.querySelector("span").textContent = torchOn ? "Flash on" : "Flash";
      } catch (e) { torchBtn.hidden = true; msg.textContent = "This camera's flash can't be turned on from the app."; }
    };
    zoomBtn.onclick = async () => {
      const t = track(); if (!t || !zoomRange) return;
      const target = zoomed ? zoomRange.min : Math.min(2, zoomRange.max);
      try {
        await t.applyConstraints({ advanced: [{ zoom: target }] });
        zoomed = !zoomed;
        zoomBtn.setAttribute("aria-pressed", String(zoomed));
        zoomBtn.textContent = zoomed ? "1×" : "2×";
        msg.textContent = zoomed ? "Zoomed in. Hold the phone farther back so the barcode is sharp." : "Fit the barcode inside the box. Hold about 6 inches away.";
      } catch (e) { zoomBtn.hidden = true; }
    };

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = "This browser can't use the camera. Tap Type it to enter the number."; return;
    }
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      } catch (e) {
        if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) throw e;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "environment" } });
      }
      if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});

      // Camera extras, only where the phone supports them.
      const t = track();
      try {
        const caps = t.getCapabilities ? t.getCapabilities() : {};
        if (caps.focusMode && caps.focusMode.includes("continuous")) t.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
        if (caps.torch) torchBtn.hidden = false;
        if (caps.zoom && caps.zoom.max >= 1.5) { zoomRange = caps.zoom; zoomBtn.hidden = false; }
      } catch (e) {}

      const native = await getNativeDetector();
      let zx = null;
      try { await loadZXing(); zx = makeZXingReader(); }
      catch (e) { if (!native) { msg.textContent = e.message; return; } }

      const readZX = (sx, sy, sw, sh, sideways) => {
        // Enlarge small regions so thin bars get enough pixels; cap the size for speed.
        const scale = Math.min(2, 1600 / Math.max(sw, sh));
        const w = Math.round(sw * scale), h = Math.round(sh * scale);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (sideways) {
          // Turn the picture a quarter turn so up-and-down barcodes read left-to-right.
          canvas.width = h; canvas.height = w;
          ctx.setTransform(0, 1, -1, 0, h, 0);
        } else { canvas.width = w; canvas.height = h; }
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        try {
          const lum = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
          return zx.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum))).getText();
        } catch (e) { return null; } // nothing found in this frame
        finally { zx.reset(); }
      };

      const tick = async () => {
        if (done) return;
        const vw = video.videoWidth, vh = video.videoHeight;
        if (vw && vh) {
          tries++;
          let code = null;
          if (native) {
            try { const r = await native.detect(video); if (r.length) code = r[0].rawValue; } catch (e) {}
          }
          if (!code && zx) {
            // Take turns: the box area, the box area turned sideways, the box area again,
            // then the whole picture, then a tall middle strip turned sideways.
            const step = tries % 5;
            if (step === 0 || step === 2) code = readZX(vw * 0.1, vh * 0.25, vw * 0.8, vh * 0.5);
            else if (step === 1) code = readZX(vw * 0.2, vh * 0.15, vw * 0.6, vh * 0.7, true);
            else if (step === 3) code = readZX(0, 0, vw, vh);
            else code = readZX(vw * 0.25, 0, vw * 0.5, vh, true);
          }
          if (code) return finish(code);
          if (tries === 60) msg.textContent = "Still looking. Tilt the jug to cut glare, try Flash, or tap Type it.";
        }
        timer = setTimeout(tick, native && !zx ? 60 : 90);
      };
      tick();
    } catch (e) {
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      msg.textContent = denied ? "Camera access is off. Allow the camera for this site in your browser settings, or tap Type it." : (e && e.message) || "The camera couldn't start. Tap Type it to enter the number.";
    }
  });
}
