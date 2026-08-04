// Sender: turn a file into an endless fountain-coded QR stream.
//
// Tuning notes from the experiments this PoC is distilled from:
// - Frame payload sets the QR version; denser wins on goodput as long as the
//   receiver can still decode it. 1465 bytes ≈ V27 is a safe middle ground
//   for arbitrary monitors; 2953 (V40) is the ceiling and works phone-to-
//   phone at close range.
// - The mask pattern is pinned (any declared mask is valid to a decoder);
//   this skips the spec's 8-way mask evaluation and speeds generation ~4×.
// - Displays need each frame shown for ≥2 refresh cycles or captures catch
//   the transition; 24 fps on a 60 Hz screen is comfortable.
// - Error correction stays at L by default: the fountain layer already
//   handles erasures, and a frame is either decoded whole or discarded.

import QRCode from "qrcode";
import { fitQrDisplaySize } from "../shared/display";
import { rasterizeGrid, rasterizeQr, rasterizeRgbQr, type QrRaster } from "../shared/qr-raster";
import { formatBytes } from "../shared/format";
import {
  MAX_SOURCE_BLOCKS,
  blockLength,
  fitsInOneStream,
  minimumFrameBytes,
  smallestSufficientFrameSize,
  sourceBlockCount,
} from "../shared/frame-capacity";
import { LTEncoder } from "../shared/fountain";
import { MAX_SNIPPET_BYTES, MAX_SNIPPET_LABEL, packSnippet } from "../shared/snippet";
import {
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  fnv1a,
  packFile,
  packFrame,
  type FrameHeader,
  type PackedOpticalFile,
} from "../shared/protocol";
import { statusLine } from "../shared/status-line";
import { requestScreenWakeLock } from "../shared/wake-lock";
import type { ColorMode, GridMode } from "../shared/send-settings";

const MARGIN = 4; // quiet-zone modules
const LOOKAHEAD = 3;

// `npm run demo` (vite --mode demo). Locks the sender to the two bundled
// payloads so the app can be left running in front of strangers without
// handing them a file picker into the host machine.
const DEMO = import.meta.env.VITE_DEMO === "1";

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLDivElement;
const specs = document.getElementById("specs")!;
const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const toolTitle = document.getElementById("tool-title")!;
const snippetText = document.getElementById("snippet-text") as HTMLTextAreaElement;
const snippetLabel = document.getElementById("snippet-label")!;
const sendSnippetBtn = document.getElementById("send-snippet") as HTMLButtonElement;
const paneFile = document.getElementById("pane-file")!;
const paneSnippet = document.getElementById("pane-snippet")!;
const paneDemo = document.getElementById("pane-demo")!;
const modePicker = document.getElementById("mode-picker")!;
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="send-mode"]')];
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgGrid = document.getElementById("cfg-grid") as HTMLSelectElement;
const cfgColor = document.getElementById("cfg-color") as HTMLSelectElement;
const cfgAdaptive = document.getElementById("cfg-adaptive") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;

let selectedFile: {
  name: string;
  size: number;
  payload: Uint8Array;
  compression: "none" | "gzip";
  transmittedSize: number;
} | null = null;
let generation = 0; // bumped on every restart; stale loops see it and die
let resizeDisplay: (() => void) | null = null;

const specsLine = statusLine(specs);
const setStatus = specsLine.setStatus;

/**
 * Errors also hide the stage — a stale QR stream pulsing away under a
 * rejection message reads as "still working".
 *
 * Callers decide whether the pick survives. A file rejected on size is gone;
 * a stream that can't start at the current bytes/frame is not, because turning
 * that setting back up is the fix.
 */
function showError(message: string): void {
  stage.hidden = true;
  specsLine.showError(message);
}

function currentMode(): "file" | "snippet" {
  return modeInputs.find((input) => input.checked)?.value === "snippet" ? "snippet" : "file";
}

/** Switching what we're sending kills any stream in flight and clears the stage. */
function applyMode(): void {
  generation++;
  selectedFile = null;
  stage.hidden = true;

  if (DEMO) {
    modePicker.hidden = true;
    paneFile.hidden = true;
    paneSnippet.hidden = true;
    paneDemo.hidden = false;
    setStatus("Choose a demo payload to begin");
    return;
  }

  const mode = currentMode();
  paneDemo.hidden = true;
  paneFile.hidden = mode !== "file";
  paneSnippet.hidden = mode !== "snippet";
  // The heading used to say "Send a file" even with Text snippet selected.
  toolTitle.textContent = mode === "snippet" ? "Send text" : "Send a file";
  setStatus(mode === "snippet" ? "Paste or type some text to begin" : "Choose a file to begin");
  // A file left in the picker survives the switch, so re-arm it rather than
  // leaving a filename on screen next to "choose a file to begin".
  if (mode === "file" && cfgFile.files?.[0]) void selectFile();
}

/**
 * The one path from "user picked something" to a running stream.
 *
 * Kills any stream in flight, then packs the payload; a selection that lands
 * mid-pack (the generation guard) or fails to pack (throw → showError) leaves
 * the page idle rather than streaming something stale. Every way of choosing a
 * payload goes through here so the guard can't be subtly wrong in one copy.
 */
async function startSelection(
  status: string,
  prepare: () => Promise<{ name: string; size: number; packed: PackedOpticalFile }>,
): Promise<void> {
  const selectionGeneration = ++generation;
  selectedFile = null;
  stage.hidden = true;
  setStatus(status);
  try {
    const { name, size, packed } = await prepare();
    if (selectionGeneration !== generation) return;
    selectedFile = {
      name,
      size,
      payload: packed.container,
      compression: packed.compression,
      transmittedSize: packed.transmittedSize,
    };
    await startStream(true);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

/** Demo payloads ship in public/, so they sit at the site root beside /send/. */
async function selectDemo(fileName: string): Promise<void> {
  await startSelection(`loading ${fileName}…`, async () => {
    const response = await fetch(`../${fileName}`);
    if (!response.ok) throw new Error(`could not load ${fileName} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { name: fileName, size: bytes.length, packed: await packFile(fileName, "image/png", bytes) };
  });
}

import {
  clearTransferHistory,
  getTransferHistory,
  recordTransferEntry,
} from "../shared/history";

const dropzoneContent = document.getElementById("dropzone-content")!;
const fileInfoCard = document.getElementById("file-info-card")!;
const fileInfoName = document.getElementById("file-info-name")!;
const fileInfoMeta = document.getElementById("file-info-meta")!;
const fileInfoClear = document.getElementById("file-info-clear")!;
const stageSeq = document.getElementById("stage-seq");

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

function updateFileInfoCard(name: string, size: number, type: string) {
  fileInfoName.textContent = name;
  fileInfoMeta.textContent = `${formatBytes(size)} · ${type || "binary"}`;
  fileInfoCard.hidden = false;
  dropzoneContent.hidden = true;
}

function clearFileInfoCard() {
  fileInfoCard.hidden = true;
  dropzoneContent.hidden = false;
  cfgFile.value = "";
}

import { encryptPayload } from "../shared/crypto";

const cfgEncrypt = document.getElementById("cfg-encrypt") as HTMLSelectElement | null;
const cfgPinContainer = document.getElementById("cfg-pin-container") as HTMLElement | null;
const cfgPin = document.getElementById("cfg-pin") as HTMLInputElement | null;
const genPinBtn = document.getElementById("gen-pin-btn") as HTMLButtonElement | null;

cfgEncrypt?.addEventListener("change", () => {
  if (cfgPinContainer) cfgPinContainer.hidden = cfgEncrypt.value !== "pin";
  void startStream();
});

genPinBtn?.addEventListener("click", () => {
  if (cfgPin) cfgPin.value = Math.floor(1000 + Math.random() * 9000).toString();
  void startStream();
});

async function handlePickedFile(file: File): Promise<void> {
  updateFileInfoCard(file.name, file.size, file.type);
  await startSelection(`preparing ${file.name}…`, async () => {
    if (file.size === 0) {
      recordTransferEntry({
        name: file.name,
        size: file.size,
        type: file.type,
        direction: "sent",
        status: "failed",
      });
      throw new Error(`${file.name} is empty — there is nothing to send.`);
    }
    if (file.size > MAX_FILE_BYTES) {
      recordTransferEntry({
        name: file.name,
        size: file.size,
        type: file.type,
        direction: "sent",
        status: "failed",
      });
      throw new Error(`${file.name} is ${formatBytes(file.size)}, over the ${MAX_FILE_LABEL} limit.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let packed = await packFile(file.name, file.type, bytes);
    if (cfgEncrypt?.value === "pin" && cfgPin?.value) {
      const encryptedContainer = await encryptPayload(packed.container, cfgPin.value.trim());
      packed = {
        ...packed,
        container: encryptedContainer,
      };
    }
    recordTransferEntry({
      name: file.name,
      size: file.size,
      type: file.type,
      direction: "sent",
      status: "completed",
    });
    return { name: file.name, size: file.size, packed };
  });
}

async function selectFile(): Promise<void> {
  const file = cfgFile.files?.[0];
  if (!file) return;
  await handlePickedFile(file);
}

async function selectSnippet(): Promise<void> {
  await startSelection("preparing text snippet…", async () => {
    let packed = await packSnippet(snippetText.value);
    if (cfgEncrypt?.value === "pin" && cfgPin?.value) {
      const encryptedContainer = await encryptPayload(packed.container, cfgPin.value.trim());
      packed = {
        ...packed,
        container: encryptedContainer,
      };
    }
    recordTransferEntry({
      name: "Text snippet",
      size: packed.originalSize,
      type: "text/plain",
      direction: "sent",
      status: "completed",
    });
    return { name: "Text snippet", size: packed.originalSize, packed };
  });
}

async function main() {
  snippetText.maxLength = MAX_SNIPPET_BYTES;
  snippetLabel.textContent = `Text to send · up to ${MAX_SNIPPET_LABEL}`;

  // Drag & drop & keyboard activation handlers on paneFile
  paneFile.addEventListener("click", (e) => {
    if (fileInfoCard.hidden && e.target !== cfgFile) {
      cfgFile.click();
    }
  });

  paneFile.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && fileInfoCard.hidden) {
      e.preventDefault();
      cfgFile.click();
    }
  });

  const preventDefaults = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    paneFile.addEventListener(eventName, preventDefaults as EventListener, false);
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    paneFile.addEventListener(
      eventName,
      () => paneFile.classList.add("drop-active"),
      false,
    );
  });

  ["dragleave", "drop"].forEach((eventName) => {
    paneFile.addEventListener(
      eventName,
      () => paneFile.classList.remove("drop-active"),
      false,
    );
  });

  paneFile.addEventListener("drop", (e: DragEvent) => {
    const dt = e.dataTransfer;
    const file = dt?.files[0];
    if (file) {
      void handlePickedFile(file);
    }
  });

  fileInfoClear.addEventListener("click", (e) => {
    e.stopPropagation();
    clearFileInfoCard();
    applyMode();
  });

  // History modal handlers
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

  if (DEMO) {
    document.querySelector(".mode-badge")!.textContent = "Demo";
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-demo]")) {
      button.addEventListener("click", () => void selectDemo(button.dataset.demo!));
    }
  } else {
    cfgFile.addEventListener("change", () => void selectFile());
    sendSnippetBtn.addEventListener("click", () => void selectSnippet());
    for (const input of modeInputs) input.addEventListener("change", applyMode);
  }
  applyMode();
  window.addEventListener("resize", () => resizeDisplay?.());
  for (const el of [cfgFps, cfgBytes, cfgGrid, cfgColor, cfgAdaptive, cfgEcc, cfgSize]) {
    if (el) el.addEventListener("change", () => void startStream());
  }

  // Quick Presets event listeners
  const btnFast = document.getElementById("preset-fast");
  const btnBalanced = document.getElementById("preset-balanced");
  const btnStable = document.getElementById("preset-stable");
  const presetBtns = [btnFast, btnBalanced, btnStable];

  const applyPreset = (fps: string, bytes: string, grid: string, activeBtn: HTMLElement | null) => {
    if (cfgFps) cfgFps.value = fps;
    if (cfgBytes) cfgBytes.value = bytes;
    if (cfgGrid) cfgGrid.value = grid;
    for (const b of presetBtns) b?.classList.remove("active");
    activeBtn?.classList.add("active");
    void startStream();
  };

  btnFast?.addEventListener("click", () => applyPreset("120", "1850", "3x3", btnFast));
  btnBalanced?.addEventListener("click", () => applyPreset("60", "1465", "1x1", btnBalanced));
  btnStable?.addEventListener("click", () => applyPreset("24", "850", "1x1", btnStable));

  await requestScreenWakeLock();
}

/** Only on a fresh pick — a settings change restarts the stream too, and
 *  yanking the page down every time you nudge tx fps is worse than useless. */
function scrollStageIntoView() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => {
    stage.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  });
}

function parseGrid(gridMode: GridMode): { cols: number; rows: number } {
  switch (gridMode) {
    case "2x1":
      return { cols: 2, rows: 1 };
    case "2x2":
      return { cols: 2, rows: 2 };
    case "3x2":
      return { cols: 3, rows: 2 };
    case "3x3":
      return { cols: 3, rows: 3 };
    case "1x1":
    default:
      return { cols: 1, rows: 1 };
  }
}

async function startStream(revealStage = false) {
  const gen = ++generation;
  resizeDisplay = null;
  if (!selectedFile) {
    setStatus(
      currentMode() === "snippet" ? "Paste or type some text to begin" : "Choose a file to begin",
    );
    return;
  }
  const { name, size: fileSize, payload } = selectedFile;
  if (gen !== generation) return; // superseded while fetching
  const txFps = Number(cfgFps.value);
  let frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const displayPx = Number(cfgSize.value);
  const gridStr = (cfgGrid?.value as GridMode) || "1x1";
  const { cols, rows } = parseGrid(gridStr);
  const totalCodesPerFrame = cols * rows;
  const colorMode = (cfgColor?.value as ColorMode) || "bw";
  const isAdaptive = cfgAdaptive?.value === "adaptive";

  // Adaptive auto-backoff heuristic: back off density if transmitting dense frames
  if (isAdaptive && frameBytes > 1850) {
    // Light heuristic backoff for stability on dense streams
    frameBytes = 1850;
  }

  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const blockLen = blockLength(frameBytes);
  if (!fitsInOneStream(payload.length, frameBytes)) {
    const offered = [...cfgBytes.options].map((option) => Number(option.value));
    const suggestion =
      smallestSufficientFrameSize(payload.length, offered) ?? minimumFrameBytes(payload.length);
    showError(
      `${formatBytes(payload.length)} needs ` +
        `${sourceBlockCount(payload.length, frameBytes).toLocaleString()} blocks at ` +
        `${frameBytes} bytes per frame, and a frame can only number ` +
        `${MAX_SOURCE_BLOCKS.toLocaleString()} of them. ` +
        `Raise bytes / frame to ${suggestion} or more.`,
    );
    return;
  }
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
  };

  let version: number | undefined; // locked after the first frame
  let totalWidth = 0;
  let totalHeight = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  let nextSeq = 0;
  stage.hidden = false;

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const containerWidth = stage.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    const stageStyle = getComputedStyle(stage);
    const horizontalChrome =
      Number.parseFloat(stageStyle.paddingLeft) +
      Number.parseFloat(stageStyle.paddingRight) +
      Number.parseFloat(stageStyle.borderLeftWidth) +
      Number.parseFloat(stageStyle.borderRightWidth);
    const cssBudget = fitQrDisplaySize(
      window.innerWidth,
      window.innerHeight,
      containerWidth,
      displayPx,
      horizontalChrome,
    );
    scale = Math.max(1, Math.floor((cssBudget * dpr) / Math.max(totalWidth, totalHeight)));
    staging.width = totalWidth;
    staging.height = totalHeight;
    canvas.width = totalWidth * scale;
    canvas.height = totalHeight * scale;
    canvas.style.width = `${(totalWidth * scale) / dpr}px`;
    canvas.style.height = `${(totalHeight * scale) / dpr}px`;
  };

  const makeFrame = (): ImageData => {
    const rasters: QrRaster[] = [];
    for (let c = 0; c < totalCodesPerFrame; c++) {
      if (colorMode === "rgb") {
        const bytesR = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
        nextSeq++;
        const bytesG = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
        nextSeq++;
        const bytesB = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
        nextSeq++;

        const qrR = QRCode.create([{ data: bytesR, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
          errorCorrectionLevel: ecc,
          version,
          maskPattern: 4,
        });
        const qrG = QRCode.create([{ data: bytesG, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
          errorCorrectionLevel: ecc,
          version: qrR.version,
          maskPattern: 4,
        });
        const qrB = QRCode.create([{ data: bytesB, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
          errorCorrectionLevel: ecc,
          version: qrR.version,
          maskPattern: 4,
        });

        if (version === undefined) version = qrR.version;

        rasters.push(
          rasterizeRgbQr(
            qrR.modules.size,
            qrR.modules.data,
            qrG.modules.data,
            qrB.modules.data,
            MARGIN,
          ),
        );
      } else {
        const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
        nextSeq++;
        const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
          errorCorrectionLevel: ecc,
          version,
          maskPattern: 4,
        });
        if (version === undefined) {
          version = qr.version;
        }

        let extraBits: Uint8Array | undefined;
        if (colorMode === "color2bit") {
          // Generate pseudo extra parity/payload bitstream for color modules
          extraBits = new Uint8Array(qr.modules.size * qr.modules.size);
          for (let i = 0; i < extraBits.length; i++) {
            extraBits[i] = (i + nextSeq) % 2;
          }
        }

        rasters.push(rasterizeQr(qr.modules.size, qr.modules.data, MARGIN, extraBits));
      }
    }

    const gridRaster = totalCodesPerFrame > 1
      ? rasterizeGrid(rasters, cols, rows, 4)
      : rasters[0]!;

    if (totalWidth === 0) {
      totalWidth = gridRaster.width;
      totalHeight = gridRaster.height;
      sizeCanvas();
      resizeDisplay = sizeCanvas;
      if (revealStage) scrollStageIntoView();
      setStatus(
        `${txFps} FPS · ${gridStr} grid · ${colorMode} · ${frameBytes} B/frame · V${version} · ECC ${ecc} · ` +
          `${name} (${formatBytes(fileSize)}) · K=${encoder.k}`,
      );
    }
    return new ImageData(
      new Uint8ClampedArray(gridRaster.pixels.buffer),
      gridRaster.width,
      gridRaster.height,
    );
  };

  let generatorFailed = false;
  const pump = (max = LOOKAHEAD) => {
    if (generatorFailed || gen !== generation) return;
    try {
      for (let n = 0; n < max && queue.length < LOOKAHEAD; n++) queue.push(makeFrame());
    } catch (err) {
      generatorFailed = true;
      showError(err instanceof Error ? err.message : String(err));
    }
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    pump(1);
    if (!img) {
      nextAt = now + interval;
      return;
    }
    staging.getContext("2d")!.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    if (stageSeq) stageSeq.textContent = `Seq: ${nextSeq} · K: ${encoder.k}`;
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval;
  };
  requestAnimationFrame(tick);
}

void main();
