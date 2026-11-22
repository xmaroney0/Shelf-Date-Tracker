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
      <div class="scan-bar"><p class="scan-msg">Point the camera at the barcode</p>
        <div class="scan-btns"><button class="btn torch" type="button" aria-pressed="false" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg><span>Flash</span></button><button class="btn cancel" type="button">Cancel</button></div></div>`;
    document.body.appendChild(wrap);
    const video = wrap.querySelector("video");
    const msg = wrap.querySelector(".scan-msg");
    const torchBtn = wrap.querySelector(".torch");
    let stream = null, done = false, reader = null, raf = 0, torchOn = false;
    const track = () => { const s = stream || video.srcObject; return s && s.getVideoTracks ? s.getVideoTracks()[0] : null; };
    // Show the flash button only on phones whose camera supports it.
    const setupTorch = () => {
      const t = track();
      if (!t || done || !t.getCapabilities) return false;
      try { if (t.getCapabilities().torch) { torchBtn.hidden = false; return true; } } catch (e) {}
      return false;
    };
    const watchTorch = () => { let tries = 0; const iv = setInterval(() => { if (setupTorch() || done || ++tries > 10) clearInterval(iv); }, 300); };
    torchBtn.onclick = async () => {
      const t = track(); if (!t) return;
      try {
        await t.applyConstraints({ advanced: [{ torch: !torchOn }] });
        torchOn = !torchOn;
        torchBtn.setAttribute("aria-pressed", String(torchOn));
        torchBtn.querySelector("span").textContent = torchOn ? "Flash on" : "Flash";
      } catch (e) { torchBtn.hidden = true; msg.textContent = "This camera's flash can't be turned on from the app."; }
    };
    const finish = (code) => {
      if (done) return; done = true;
      cancelAnimationFrame(raf);
      try { const t = track(); if (torchOn && t) t.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {}); } catch (e) {}
      try { reader && reader.reset(); } catch (e) {}
      const s = stream || video.srcObject;
      if (s && s.getTracks) s.getTracks().forEach((t) => t.stop());
      wrap.remove();
      if (code && navigator.vibrate) navigator.vibrate(60);
      resolve(code || null);
    };
    wrap.querySelector(".cancel").onclick = () => finish(null);

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
        watchTorch();
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
        watchTorch(); // the camera stream appears on the video once ZXing starts it
        await reader.decodeFromConstraints({ video: { facingMode: "environment" }, audio: false }, video, (result) => { if (result) finish(result.getText()); });
      }
    } catch (e) {
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      msg.textContent = denied ? "Camera access is off. Allow the camera for this site in your browser settings, or type the number." : (e && e.message) || "The camera couldn't start. Type the number instead.";
    }
  });
}
