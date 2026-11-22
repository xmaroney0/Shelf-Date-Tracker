// Live barcode scanning with the phone camera.
// Uses the browser's built-in BarcodeDetector where it exists (Android Chrome),
// and the ZXing library everywhere else (iPhone Safari).
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

// Opens a full-screen camera view. Resolves with the code, or null if cancelled.
export function scanBarcode() {
  return new Promise(async (resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "scanner";
    wrap.innerHTML = `<video playsinline muted></video><div class="scan-frame" aria-hidden="true"></div>
      <div class="scan-bar"><p class="scan-msg">Point the camera at the barcode</p><button class="btn" type="button">Cancel</button></div>`;
    document.body.appendChild(wrap);
    const video = wrap.querySelector("video");
    const msg = wrap.querySelector(".scan-msg");
    let stream = null, done = false, reader = null, raf = 0;
    const finish = (code) => {
      if (done) return; done = true;
      cancelAnimationFrame(raf);
      try { reader && reader.reset(); } catch (e) {}
      if (stream) stream.getTracks().forEach((t) => t.stop());
      wrap.remove();
      if (code && navigator.vibrate) navigator.vibrate(60);
      resolve(code || null);
    };
    wrap.querySelector("button").onclick = () => finish(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = "This browser can't use the camera. Type the number instead."; return;
    }
    const formats = ["upc_a", "upc_e", "ean_13", "ean_8", "code_128"];
    let native = null;
    if ("BarcodeDetector" in window) {
      try { const sup = await BarcodeDetector.getSupportedFormats(); if (formats.some((f) => sup.includes(f))) native = new BarcodeDetector({ formats: formats.filter((f) => sup.includes(f)) }); } catch (e) {}
    }
    try {
      if (native) {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
        video.srcObject = stream; await video.play();
        const tick = async () => {
          if (done) return;
          try { const r = await native.detect(video); if (r.length) return finish(r[0].rawValue); } catch (e) {}
          raf = requestAnimationFrame(tick);
        };
        tick();
      } else {
        await loadZXing();
        if (done) return;
        const hints = new Map();
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E, ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.CODE_128]);
        reader = new ZXing.BrowserMultiFormatReader(hints, 150);
        await reader.decodeFromConstraints({ video: { facingMode: "environment" }, audio: false }, video, (result) => { if (result) finish(result.getText()); });
      }
    } catch (e) {
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      msg.textContent = denied ? "Camera access is off. Allow the camera for this site in your browser settings, or type the number." : (e && e.message) || "The camera couldn't start. Type the number instead.";
    }
  });
}
