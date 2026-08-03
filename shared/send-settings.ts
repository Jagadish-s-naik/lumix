// The sender's transmit tuning, in one place. The dropdowns in send/index.html
// are rendered from these lists via the %TX_FPS_OPTIONS% / %FRAME_BYTES_OPTIONS%
// tokens (see htmlTokens() in vite.config.ts), and the receiver's no-signal
// hint names its fallback values from here too — so the advice can never point
// at a setting the sender doesn't offer.

/** What the no-signal hint tells the user to turn the sender down to. */
export const NO_SIGNAL_HINT_FRAME_BYTES = 1465;
export const NO_SIGNAL_HINT_TX_FPS = 24;

export const DEFAULT_TX_FPS = 60;
export const DEFAULT_FRAME_BYTES = 2953;

// The hint values appear in these lists by construction, not by coincidence.
export const TX_FPS_OPTIONS: readonly number[] = [10, 15, 20, NO_SIGNAL_HINT_TX_FPS, 30, DEFAULT_TX_FPS, 120];
export const FRAME_BYTES_OPTIONS: readonly number[] = [
  500,
  1000,
  NO_SIGNAL_HINT_FRAME_BYTES,
  1850,
  2331,
  DEFAULT_FRAME_BYTES,
];

export type GridMode = "1x1" | "2x1" | "2x2" | "3x2" | "3x3";
export const DEFAULT_GRID_MODE: GridMode = "1x1";
export const GRID_MODE_OPTIONS: readonly GridMode[] = ["1x1", "2x1", "2x2", "3x2", "3x3"];

export type ColorMode = "bw" | "color2bit";
export const DEFAULT_COLOR_MODE: ColorMode = "bw";
export const COLOR_MODE_OPTIONS: readonly ColorMode[] = ["bw", "color2bit"];

export type AdaptiveMode = "off" | "adaptive";
export const DEFAULT_ADAPTIVE_MODE: AdaptiveMode = "off";

