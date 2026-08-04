// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.

import wasmUrl from "./wasm-url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

function extractChannel(rawData: Uint8ClampedArray, w: number, h: number, channelOffset: number): ImageData {
  const channelData = new Uint8ClampedArray(w * h * 4);
  const totalPixels = w * h;
  for (let i = 0; i < totalPixels; i++) {
    const val = rawData[i * 4 + channelOffset]!;
    const dest = i * 4;
    channelData[dest] = val;
    channelData[dest + 1] = val;
    channelData[dest + 2] = val;
    channelData[dest + 3] = 255;
  }
  return new ImageData(channelData, w, h);
}

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, w, h } = e.data as { id: number; buf: ArrayBuffer; w: number; h: number };
  try {
    const rawData = new Uint8ClampedArray(buf);
    const img = new ImageData(rawData, w, h);
    const options = {
      formats: ["QRCode" as const],
      maxNumberOfSymbols: 6,
      tryHarder: true,
      tryRotate: true,
    };
    const results = await readBarcodes(img, options);
    const allBytes: Uint8Array[] = [];
    for (const r of results) {
      if (r.isValid && r.bytes.length > 0) allBytes.push(r.bytes);
    }

    // Split RGB channels (0=R, 1=G, 2=B) to decode multi-layer multiplexed optical codes
    if (allBytes.length < 3) {
      for (let ch = 0; ch < 3; ch++) {
        const chImg = extractChannel(rawData, w, h, ch);
        const chResults = await readBarcodes(chImg, options);
        for (const r of chResults) {
          if (r.isValid && r.bytes.length > 0) {
            const exists = allBytes.some(
              (b) => b.length === r.bytes.length && b.every((val, idx) => val === r.bytes[idx]),
            );
            if (!exists) allBytes.push(r.bytes);
          }
        }
      }
    }

    ctx.postMessage({ id, results: allBytes });
  } catch {
    ctx.postMessage({ id, results: [] });
  }
};

// warm the WASM so the first real frame doesn't pay instantiation
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytes: null }));
