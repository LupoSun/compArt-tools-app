/* Browser-native artwork recording. UI and artwork rendering belong to the caller. */
(() => {
  "use strict";
  const candidates = [
    ["video/mp4;codecs=avc1.42E01E", "MP4", "mp4"],
    ["video/mp4", "MP4", "mp4"],
    ["video/webm;codecs=vp9", "WebM", "webm"],
    ["video/webm;codecs=vp8", "WebM", "webm"],
    ["video/webm", "WebM", "webm"]
  ];
  function formats() {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function" || !HTMLCanvasElement.prototype.captureStream) return [];
    const found = new Set();
    return candidates.filter(([mime, label]) => {
      if (found.has(label) || !MediaRecorder.isTypeSupported(mime)) return false;
      found.add(label); return true;
    }).map(([mime, label, extension]) => ({ mime, label, extension }));
  }
  function record({ render, format, fps, seconds, onCanvas, onProgress, onComplete, onError }) {
    if (!formats().some(item => item.mime === format.mime)) throw new Error("This recording format is unavailable in this browser.");
    let output, context, stream, recorder, frameId, timeoutId, started, clockContext, clockSource;
    let cancelled = false, failed = false, lastDraw = 0, pendingStop = false, hasStarted = false;
    const chunks = [];
    const cleanup = () => {
      cancelAnimationFrame(frameId); clearTimeout(timeoutId);
      stream?.getTracks().forEach(track => track.stop());
      clockSource?.stop();
      if (clockContext && clockContext.state !== "closed") clockContext.close().catch(() => {});
      if (output) output.width = output.height = 1;
      document.removeEventListener("visibilitychange", visibility);
    };
    const fail = error => {
      if (failed) return;
      failed = true; cancelled = true;
      if (recorder?.state !== "inactive" && recorder?.state) recorder.stop();
      cleanup(); onError(error);
    };
    const stop = (discard = false) => {
      cancelled ||= discard;
      cancelAnimationFrame(frameId); clearTimeout(timeoutId);
      if (!hasStarted) { pendingStop = true; return; }
      if (recorder?.state !== "inactive" && recorder?.state) recorder.stop();
    };
    const visibility = () => { if (document.hidden) fail(new Error("Recording stopped because the tab was hidden. Keep HanSketch visible while recording.")); };
    const draw = now => {
      try {
        if (now - lastDraw >= 1000 / fps - 1) {
          const image = render();
          context.clearRect(0, 0, output.width, output.height);
          context.drawImage(image, 0, 0);
          stream.getVideoTracks()[0]?.requestFrame?.();
          image.width = image.height = 1;
          lastDraw = now;
          onProgress(Math.max(0, Math.min(seconds, (now - started) / 1000)));
        }
        frameId = requestAnimationFrame(draw);
      } catch (error) { fail(error); }
    };
    try {
      output = render(); // Paint the first frame before starting the encoder.
      onCanvas?.(output);
      context = output.getContext("2d");
      stream = output.captureStream(0);
      if (typeof stream.getVideoTracks()[0]?.requestFrame !== "function") {
        stream.getTracks().forEach(track => track.stop());
        stream = output.captureStream(fps);
      }
      // A silent timing track preserves the requested duration even when an
      // encoder coalesces identical video frames (paused or very still artwork).
      const AudioClock = window.AudioContext || window.webkitAudioContext;
      if (AudioClock) {
        clockContext = new AudioClock();
        const destination = clockContext.createMediaStreamDestination();
        const gain = clockContext.createGain(); gain.gain.value = 0;
        clockSource = clockContext.createOscillator(); clockSource.connect(gain); gain.connect(destination);
        clockSource.start();
        for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
      }
      recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 6000000 });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => fail(event.error || new Error("The browser could not encode the recording."));
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || format.mime });
        cleanup();
        if (failed) return;
        if (!cancelled && !blob.size) { onError(new Error("The browser returned an empty recording.")); return; }
        onComplete(cancelled ? null : blob, format.extension);
      };
      const start = () => {
        if (failed) return;
        if (pendingStop) { cleanup(); onComplete(null, format.extension); return; }
        try {
          recorder.start(1000); hasStarted = true;
          context.drawImage(output, 0, 0);
          stream.getVideoTracks()[0]?.requestFrame?.();
          started = performance.now();
          timeoutId = setTimeout(() => stop(), seconds * 1000);
          frameId = requestAnimationFrame(draw);
          document.addEventListener("visibilitychange", visibility);
        } catch (error) { fail(error); }
      };
      if (clockContext) clockContext.resume().then(start).catch(fail);
      else start();
      return { stop: () => stop(), cancel: () => stop(true) };
    } catch (error) { cleanup(); throw error; }
  }
  window.HanSketchAnimation = Object.freeze({ formats, record });
})();
