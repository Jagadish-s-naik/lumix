// Paint a QR module matrix into a pixel buffer, quiet zone included.
//
// Pure so it can be golden-tested in Node, where ImageData does not exist:
// the pixels are RGBA bytes viewed as one little-endian u32 per pixel, which
// is exactly an ImageData buffer — the sender wraps the result with
// `new ImageData(new Uint8ClampedArray(pixels.buffer), size, size)` at no copy.

const WHITE = 0xffffffff;
const BLACK = 0xff000000; // opaque black (ABGR in little-endian u32: 0xFF000000)

// 4 distinct color palette (RGBA in little-endian u32)
// Black (00), Red (01), Cyan/Green (10), Blue (11)
// Notice dark/bright contrasts so when converted to luminance (B/W fallback):
// Black & Blue have low luminance (dark modules), Red & Cyan/White have distinct contrasts.
// To ensure standard B/W QR decoders can still read color QR codes as fallback,
// bit 0 determines luminance: 0 = Dark (Black / Dark Blue), 1 = Light (Red / Bright Cyan).
// In little endian u32: 0xAABBGGRR
const PALETTE_2BIT: readonly number[] = [
  0xff000000, // Black (Dark, bit 0=0, extra bit 0=0)
  0xff0000d8, // Red (Dark/Mid, bit 0=0, extra bit 1=1)
  0xffd8d800, // Cyan (Light, bit 0=1, extra bit 0=0)
  0xffffffff, // White (Light, bit 0=1, extra bit 1=1)
];

export interface QrRaster {
  width: number;
  height: number;
  size: number;
  pixels: Uint32Array<ArrayBuffer>;
}

export function rasterizeQr(
  moduleCount: number,
  modules: ArrayLike<number>,
  margin: number,
  extraBits?: ArrayLike<number>,
): QrRaster {
  const size = moduleCount + 2 * margin;
  const pixels = new Uint32Array(size * size);
  pixels.fill(WHITE);
  for (let y = 0; y < moduleCount; y++) {
    const row = (y + margin) * size + margin;
    const src = y * moduleCount;
    for (let x = 0; x < moduleCount; x++) {
      const dark = modules[src + x];
      if (dark) {
        if (extraBits) {
          const bit1 = extraBits[src + x] ? 1 : 0;
          // Palette: 0=Black, 1=Red, 2=Cyan, 3=White
          // Dark module base: 0 (Black) or 1 (Red)
          pixels[row + x] = PALETTE_2BIT[bit1]!;
        } else {
          pixels[row + x] = BLACK;
        }
      } else {
        if (extraBits) {
          const bit1 = extraBits[src + x] ? 1 : 0;
          // Light module base: 2 (Cyan) or 3 (White)
          pixels[row + x] = PALETTE_2BIT[2 + bit1]!;
        }
      }
    }
  }
  return { width: size, height: size, size, pixels };
}

export function rasterizeRgbQr(
  moduleCount: number,
  modulesR: ArrayLike<number>,
  modulesG: ArrayLike<number>,
  modulesB: ArrayLike<number>,
  margin: number,
): QrRaster {
  const size = moduleCount + 2 * margin;
  const pixels = new Uint32Array(size * size);
  pixels.fill(WHITE);
  for (let y = 0; y < moduleCount; y++) {
    const row = (y + margin) * size + margin;
    const src = y * moduleCount;
    for (let x = 0; x < moduleCount; x++) {
      const darkR = modulesR[src + x] ? 0 : 0xff;
      const darkG = modulesG[src + x] ? 0 : 0xff;
      const darkB = modulesB[src + x] ? 0 : 0xff;
      // In little-endian u32: 0xAABBGGRR
      pixels[row + x] = 0xff000000 | (darkB << 16) | (darkG << 8) | darkR;
    }
  }
  return { width: size, height: size, size, pixels };
}

export function rasterizeGrid(
  rasters: QrRaster[],
  cols: number,
  rows: number,
  gap = 8,
): QrRaster {
  if (rasters.length === 0) {
    return { width: 0, height: 0, size: 0, pixels: new Uint32Array(0) };
  }
  const singleW = rasters[0]!.width;
  const singleH = rasters[0]!.height;
  const totalW = cols * singleW + (cols + 1) * gap;
  const totalH = rows * singleH + (rows + 1) * gap;
  const pixels = new Uint32Array(totalW * totalH);
  pixels.fill(WHITE);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= rasters.length) break;
      const sub = rasters[idx]!;
      const startX = gap + c * (singleW + gap);
      const startY = gap + r * (singleH + gap);

      for (let y = 0; y < sub.height; y++) {
        const destRow = (startY + y) * totalW + startX;
        const srcRow = y * sub.width;
        for (let x = 0; x < sub.width; x++) {
          pixels[destRow + x] = sub.pixels[srcRow + x]!;
        }
      }
    }
  }

  return { width: totalW, height: totalH, size: Math.max(totalW, totalH), pixels };
}

