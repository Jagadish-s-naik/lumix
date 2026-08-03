// Receiver: camera → WASM QR decode in workers → fountain decoder → file.
//
// Field lessons baked in:
// - iOS treats `frameRate: {ideal: 60}` as a suggestion and delivers 30.
//   Demand `exact` first (it works at 1280-wide), fall back to `ideal`.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress must track frames COLLECTED: LT peeling back-loads its solve
//   cascade, so blocks-solved looks stalled and then teleports to done.

import { formatBytes } from "../shared/format";
import { LTDecoder } from "../shared/fountain";
import {
  estimateTransferProgress,
  expectedFountainOverhead,
  formatDuration,
} from "../shared/progress";
import { createDecodeWorker } from "./worker-factory";
import { NoSignalHintTimer } from "../shared/no-signal";
import { DecodeWorkerPool } from "../shared/worker-pool";
import { isSnippet, snippetText } from "../shared/snippet";
import { fnv1a, parseFrame, streamIdentity, unpackFile, verifyFile } from "../shared/protocol";
import { NO_SIGNAL_HINT_FRAME_BYTES, NO_SIGNAL_HINT_TX_FPS } from "../shared/send-settings";
import { statusLine } from "../shared/status-line";
import { requestScreenWakeLock } from "../shared/wake-lock";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const progressStatus = document.getElementById("progress-status")!;
const progressLabel = document.getElementById("progress-label")!;
const etaLabel = document.getElementById("eta-label")!;
const result = document.getElementById("result")!;
const metricsEl = document.getElementById("metrics")!;
const diagnosticsEl = document.getElementById("diagnostics") as HTMLDetailsElement | null;
const cfgWidth = document.getElementById("cfg-width") as HTMLSelectElement;
const cfgCapFps = document.getElementById("cfg-capfps") as HTMLSelectElement;
const cfgWorkers = document.getElementById("cfg-workers") as HTMLSelectElement;
const cameraActual = document.getElementById("camera-actual")!;
const metric = (id: string) => document.getElementById(id)!;

// Nothing has decoded in this long → the sender is almost certainly too dense
// for this camera. Also the delay before a dismissed hint comes back, since
// dismissing it doesn't make the transfer start working.
const NO_SIGNAL_AFTER_MS = 10_000;

// Sliding window for the capture/decode fps metrics — the per-second rates in
// updateStats() are derived from this, so the window and the divisor can't
// drift apart.
const STATS_WINDOW_MS = 2000;

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let streamKey = "";
let startTs = 0;
let captureGen = 0;
let done = false;
let settingsWired = false;
let statsTimer: ReturnType<typeof setInterval> | undefined;

const noSignal = new NoSignalHintTimer(NO_SIGNAL_AFTER_MS);
const pool = new DecodeWorkerPool(createDecodeWorker, (bytes) => onDecoded(bytes));
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

startBtn.onclick = () => void start();

const { setStatus, showError } = statusLine(stats);

/** By the time a transfer ends the camera, worker pool and stats timer are all
 *  torn down and `done` is latched, so a reload is the honest way back to a
 *  live receiver — and it drops the recovered bytes from memory on the way. */
function restartButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = label;
  button.addEventListener("click", () => window.location.reload());
  return button;
}

/** Put the page back the way it was so a refused camera can be retried without
 *  a reload. Tapping "Block" by accident on the permission prompt is easy, and
 *  a dead page with no button is a bad answer to it. */
function offerRetry(message: string) {
  startBtn.disabled = false;
  startBtn.style.display = "";
  startBtn.textContent = "Start camera";
  preview.style.display = "none";
  metricsEl.style.display = "none";
  if (diagnosticsEl) diagnosticsEl.style.display = "none";
  showError(message);
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    // On insecure origins the API doesn't exist AT ALL — this is the plain-
    // http-over-LAN case. localhost is exempt; other hosts need https.
    showError(
      "camera needs a secure context — this page must be served over https to " +
        "use the camera from another device. `npm run dev` already is.",
    );
    return;
  }
  const captureWidth = Number(cfgWidth.value);
  const captureFps = Number(cfgCapFps.value);
  // Nothing on the page changes until the camera is actually running: the
  // error paths below all have to leave a usable Start button behind.
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";
  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: captureWidth },
    height: { ideal: Math.round((captureWidth * 3) / 4) },
  };
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps } },
      });
    }
  } catch (err) {
    const denied = err instanceof DOMException && err.name === "NotAllowedError";
    offerRetry(
      denied
        ? "camera permission denied — allow it, then tap Start camera again."
        : `camera: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  startBtn.style.display = "none";
  preview.style.display = "block";
  metricsEl.style.display = "grid";
  if (diagnosticsEl) diagnosticsEl.style.display = "block";
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  const settings = stream.getVideoTracks()[0]?.getSettings();
  setStatus(
    `camera ${settings?.width}×${settings?.height}@${settings?.frameRate} — searching for a stream…`,
  );

  pool.resize(Number(cfgWorkers.value));
  reportCameraSettings();
  if (!settingsWired) {
    settingsWired = true;
    for (const el of [cfgWidth, cfgCapFps, cfgWorkers]) {
      el.addEventListener("change", () => void applyReceiveSettings());
    }
  }

  noSignal.cameraStarted(performance.now());
  captureGen++;
  scheduleFrame(captureGen);
  statsTimer = setInterval(updateStats, 500);
  await requestScreenWakeLock();
}

/** Report what the camera actually negotiated — iOS in particular will happily
 *  hand back 30 fps after accepting a request for 60. */
function reportCameraSettings() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const s = track.getSettings();
  const askedFps = Number(cfgCapFps.value);
  const gotFps = Math.round(s.frameRate ?? 0);
  const fpsNote = gotFps && gotFps !== askedFps ? ` (asked ${askedFps})` : "";
  cameraActual.textContent =
    `camera ${s.width}×${s.height} @ ${gotFps} fps${fpsNote} · ${pool.size} decode ` +
    `worker${pool.size === 1 ? "" : "s"} · changes apply live`;
}

async function applyReceiveSettings() {
  // finish() has already torn the pool down — don't resurrect it.
  if (done) return;
  pool.resize(Number(cfgWorkers.value));
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const width = Number(cfgWidth.value);
  try {
    await track.applyConstraints({
      width: { ideal: width },
      height: { ideal: Math.round((width * 3) / 4) },
      frameRate: { ideal: Number(cfgCapFps.value) },
    });
  } catch {
    // Some devices (notably iOS) refuse a live reconfigure. Keep the stream we
    // have rather than tearing down a transfer in progress.
    cameraActual.textContent = "this camera refused a live change — restart to apply";
    return;
  }
  reportCameraSettings();
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  if (pool.busyCount === pool.size) return; // all busy — drop it, no harm done
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  pool.submit({ id: frameId++, buf: img.data.buffer, w: vw, h: vh }, [img.data.buffer]);
}

import { decryptPayload, isEncryptedContainer } from "../shared/crypto";
import {
  clearPartialSession,
  loadPartialSession,
  savePartialSession,
} from "../shared/session-storage";

const resumeBanner = document.getElementById("resume-banner");
const resumePercent = document.getElementById("resume-percent");
const pinDialog = document.getElementById("pin-dialog") as HTMLDialogElement | null;
const recPinInput = document.getElementById("rec-pin-input") as HTMLInputElement | null;
const submitPinBtn = document.getElementById("submit-pin-btn") as HTMLButtonElement | null;

const receivedFramesMap = new Map<string, { seq: number; data: Uint8Array }[]>();

async function onDecoded(bytes: Uint8Array) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  if (noSignal.frameDecoded()) result.replaceChildren();

  const identity = streamIdentity(header);
  if (!decoder || streamKey !== identity) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    streamKey = identity;
    startTs = performance.now();
    progressEl.style.display = "block";
    progressStatus.style.display = "flex";

    // Check IndexedDB for existing partial session resume
    const saved = await loadPartialSession(identity);
    if (saved && saved.frames.length > 0) {
      let restoredCount = 0;
      const list: { seq: number; data: Uint8Array }[] = [];
      for (const item of saved.frames) {
        const frameBuf = new Uint8Array(item.data);
        decoder.addFrame(item.seq, frameBuf);
        list.push({ seq: item.seq, data: frameBuf });
        restoredCount++;
      }
      receivedFramesMap.set(identity, list);
      const est = estimateTransferProgress(decoder.k, decoder.framesNew, 0.1, decoder.solvedCount);
      const restoredPercent = Math.round(est.fraction * 100);
      if (resumeBanner && resumePercent) {
        resumePercent.textContent = `${restoredPercent}%`;
        resumeBanner.style.display = "block";
        setTimeout(() => { resumeBanner.style.display = "none"; }, 5000);
      }
    }
  }

  decoder.addFrame(header.seq, block);
  
  // Track and throttle saving partial session
  let list = receivedFramesMap.get(identity);
  if (!list) {
    list = [];
    receivedFramesMap.set(identity, list);
  }
  list.push({ seq: header.seq, data: block });
  if (list.length % 5 === 0) {
    void savePartialSession({
      sessionId: header.sessionId,
      identityKey: identity,
      k: header.k,
      blockLen: header.blockLen,
      totalLen: header.totalLen,
      payloadFnv: header.payloadFnv,
      frames: list.map((f) => ({ seq: f.seq, data: Array.from(f.data) })),
      updatedAt: Date.now(),
    });
  }

  updateProgressEstimate();

  if (decoder.isComplete) {
    let payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    void clearPartialSession(identity);

    if (isEncryptedContainer(payload)) {
      if (pinDialog) {
        pinDialog.showModal();
      }
      if (submitPinBtn) {
        submitPinBtn.onclick = async () => {
          const pin = recPinInput?.value.trim() || "";
          try {
            const decryptedPayload = await decryptPayload(payload, pin);
            const ok = fnv1a(decryptedPayload) === header.payloadFnv;
            pinDialog?.close();
            void finish(decryptedPayload, ok, seconds);
          } catch (err) {
            showError(err instanceof Error ? err.message : String(err));
          }
        };
      }
      return;
    }

    const ok = fnv1a(payload) === header.payloadFnv;
    void finish(payload, ok, seconds);
  }
}

import {
  clearTransferHistory,
  getTransferHistory,
  recordTransferEntry,
} from "../shared/history";

const stageStepper = document.getElementById("stage-stepper");
const stepCollect = document.getElementById("step-collect");
const stepReconstruct = document.getElementById("step-reconstruct");

const historyDialog = document.getElementById("history-dialog") as HTMLDialogElement | null;
const openHistoryBtn = document.getElementById("open-history") as HTMLButtonElement | null;
const closeHistoryBtn = document.getElementById("close-history") as HTMLButtonElement | null;
const clearHistoryBtn = document.getElementById("clear-history") as HTMLButtonElement | null;
const historyContainer = document.getElementById("history-list-container")!;

function renderHistoryUI() {
  const history = getTransferHistory();
  if (history.length === 0) {
    historyContainer.innerHTML = `<p class="empty-history">No transfer history recorded yet.</p>`;
    return;
  }
  historyContainer.innerHTML = history
    .map((item) => {
      const dateStr = new Date(item.timestamp).toLocaleString();
      const dirBadge = item.direction === "sent" ? "SENT" : "RECEIVED";
      const statusClass = item.status === "completed" ? "status-ok" : "status-err";
      return `
      <div class="history-item">
        <div class="history-item-top">
          <span class="history-dir ${item.direction}">${dirBadge}</span>
          <strong class="history-name">${item.name}</strong>
        </div>
        <div class="history-item-sub">
          <span>${formatBytes(item.size)} · ${item.type || "file"}</span>
          <span class="${statusClass}">${item.status}</span>
        </div>
        <div class="history-item-time">${dateStr}</div>
      </div>
    `;
    })
    .join("");
}

openHistoryBtn?.addEventListener("click", () => {
  renderHistoryUI();
  historyDialog?.showModal();
});

closeHistoryBtn?.addEventListener("click", () => {
  historyDialog?.close();
});

clearHistoryBtn?.addEventListener("click", () => {
  clearTransferHistory();
  renderHistoryUI();
});

function updateProgressEstimate() {
  if (!decoder) return;
  if (stageStepper) stageStepper.style.display = "flex";
  const elapsed = Math.max(0, (performance.now() - startTs) / 1000);
  const estimate = estimateTransferProgress(
    decoder.k,
    decoder.framesNew,
    elapsed,
    decoder.solvedCount,
  );
  const percent = estimate.fraction * 100;
  const shownPercent = percent < 10 ? percent.toFixed(1) : percent.toFixed(0);
  bar.style.width = `${percent.toFixed(1)}%`;
  progressEl.setAttribute("aria-valuenow", String(Math.floor(percent)));

  const isReconstructing = estimate.phase === "decoding" || decoder.solvedCount >= decoder.k * 0.9;
  if (stepCollect && stepReconstruct) {
    if (isReconstructing) {
      stepCollect.classList.remove("active");
      stepReconstruct.classList.add("active");
    } else {
      stepCollect.classList.add("active");
      stepReconstruct.classList.remove("active");
    }
  }

  const phaseLabel = isReconstructing ? "Reconstructing file" : "Collecting blocks";
  progressLabel.textContent =
    `${shownPercent}% · ${decoder.solvedCount}/${decoder.k} blocks · ${phaseLabel}`;

  const rate = decoder.framesNew >= 4 ? ` · ${goodputKbs(elapsed).toFixed(1)} KB/s` : "";
  etaLabel.textContent =
    (estimate.etaSeconds === undefined
      ? isReconstructing
        ? `${decoder.framesNew} frames · solving system`
        : "Collecting fountain frames…"
      : `About ${formatDuration(estimate.etaSeconds)} · ${decoder.framesNew} frames`) + rate;
}

/** Payload KB/s, discounting the frames the fountain spends on overhead. That
 *  discount is k-dependent — assuming a flat 1.18 over-reported small transfers
 *  by up to 2×, because a short stream needs far more redundancy per block. */
function goodputKbs(elapsed: number): number {
  if (!decoder) return 0;
  return (
    (decoder.framesNew * decoder.blockLen) /
    expectedFountainOverhead(decoder.k) /
    1024 /
    Math.max(0.1, elapsed)
  );
}

async function finish(container: Uint8Array, hashOk: boolean, seconds: number) {
  done = true;
  captureGen++;
  stream?.getTracks().forEach((t) => t.stop());
  clearInterval(statsTimer);
  statsTimer = undefined;
  pool.resize(0);
  preview.style.display = "none";
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  etaLabel.textContent = `${formatDuration(seconds)} total`;
  try {
    if (!hashOk) throw new Error("The optical stream checksum did not match.");
    const file = await unpackFile(container);
    if (!(await verifyFile(file))) throw new Error("The recovered file failed SHA-256 verification.");

    const rate = (container.length / 1024 / seconds).toFixed(1);
    const gzipNote = file.compression === "gzip" ? "gzip decompressed · " : "";

    recordTransferEntry({
      name: file.name,
      size: file.bytes.length,
      type: file.type,
      direction: "received",
      status: "completed",
      goodputKbs: Number(rate),
    });

    if (isSnippet(file)) {
      progressLabel.textContent = "100% · text recovered";
      setStatus(`text in ${seconds.toFixed(1)} s · ${rate} KB/s · ${gzipNote}SHA-256 verified ✓`);
      showSnippet(snippetText(file));
      return;
    }

    progressLabel.textContent = "100% · file recovered";
    const kb = Math.round(file.bytes.length / 1024);
    setStatus(`${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · ${gzipNote}SHA-256 verified ✓`);
    const heading = document.createElement("div");
    heading.className = "done";
    heading.textContent = "Transfer Complete!";
    const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
    const download = document.createElement("a");
    download.className = "download";
    download.href = url;
    download.download = file.name;
    download.textContent = `Save ${file.name}`;
    const actions = document.createElement("div");
    actions.className = "note-actions";
    actions.append(download, restartButton("Receive another"));
    result.replaceChildren(heading, actions);
    if (file.type.startsWith("image/")) {
      const image = document.createElement("img");
      image.className = "received";
      image.alt = `Received file preview: ${file.name}`;
      image.src = url;
      result.append(image);
    }
  } catch (error) {
    // Everything is already torn down by this point, so the only way back to a
    // live receiver is a reload. Offer it: a failed checksum used to leave the
    // page dead with nothing but an error string on it.
    bar.classList.add("error");
    etaLabel.textContent = "Transfer failed";
    showError(error instanceof Error ? error.message : String(error));
    const heading = document.createElement("div");
    heading.className = "failed";
    heading.textContent = "Transfer failed";
    const detail = document.createElement("p");
    detail.className = "received-note";
    detail.textContent =
      "Nothing usable came out of that stream. Restart the sender, then scan it again — " +
      "a partial transfer costs nothing but the time.";
    result.replaceChildren(heading, detail, restartButton("Try again"));
  }
}

/**
 * Ten seconds of camera and not one decoded frame.
 *
 * Both real fixes are on the SENDER, which is the non-obvious part — someone
 * staring at a blank receiver reaches for the phone. The defaults (2953 bytes
 * per frame at 60 fps) are tuned for a close-range phone-to-phone demo and are
 * exactly the combination that fails on an ordinary monitor at arm's length.
 *
 * Dismissing it only re-arms the countdown: nothing about tapping the button
 * makes frames start arriving, so if the transfer is still dead ten seconds
 * later the advice is still the advice. It stops for good on the first frame
 * that parses, which is the only thing that actually means it worked.
 */
function showNoSignalHint() {
  const panel = document.createElement("div");
  panel.className = "no-signal";
  // It appears on a timer rather than in response to anything the user did,
  // which is exactly what a live region is for.
  panel.setAttribute("role", "status");

  const heading = document.createElement("strong");
  heading.textContent = "Nothing decoded yet — try this";
  const list = document.createElement("ul");
  for (const line of [
    `On the sender, open Transfer settings and drop bytes / frame to ${NO_SIGNAL_HINT_FRAME_BYTES}.`,
    `Still nothing? Drop the sender's tx fps to ${NO_SIGNAL_HINT_TX_FPS} as well.`,
    "Fill this camera's view with the code, and prop the phone against something — autofocus hunting from hand tremor is the usual culprit.",
    "Turn the sending screen's brightness all the way up.",
  ]) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "text-button no-signal-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    noSignal.dismiss(performance.now());
    result.replaceChildren();
  });

  panel.append(heading, list, dismiss);
  result.replaceChildren(panel);
}

/** Nothing is persisted: the text lives here until the page is closed. */
function showSnippet(text: string) {
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Text received";

  const body = document.createElement("p");
  body.className = "received-note";
  body.textContent = text;

  const actions = document.createElement("div");
  actions.className = "note-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "text-button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  actions.append(copy, restartButton("Receive another"));

  result.replaceChildren(heading, body, actions);
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - STATS_WINDOW_MS) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  const perSecond = (a: number[]) => a.length / (STATS_WINDOW_MS / 1000);
  const capFps = perSecond(captureTimes);
  const decFps = perSecond(decodeTimes);
  metric("m-cap").textContent = capFps.toFixed(0);
  metric("m-dec").textContent = decFps.toFixed(1);
  const successRate = capFps > 0 ? Math.min(100, Math.round((decFps / capFps) * 100)) : 0;
  const mSuccess = document.getElementById("m-success");
  if (mSuccess) mSuccess.textContent = `${successRate}%`;
  if (noSignal.tick(now)) showNoSignalHint();
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  updateProgressEstimate();
  metric("m-rate").textContent = `${goodputKbs(elapsed).toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent = `${Math.round(decoder.totalLen / 1024)} KB`;
}
