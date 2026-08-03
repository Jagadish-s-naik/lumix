# Lumix: fountain-coded QR file transfer

Send a file or text between two devices using nothing but a **screen and a camera**.
One page displays the payload as an endless stream of animated QR codes; another
device points its camera at it and reconstructs the data. **No network path
between the devices, no app installation required, no pairing, no permissions beyond the camera.**
The payload travels purely as light.

**Live at [lumix.app](https://lumix.app/)** — open it on both devices and
go. Works offline after the first visit and can be installed as a PWA.

Lumix uses Luby transform (LT) fountain coding to pack arbitrary files up to 64 MB (or text snippets), preserving filename and media type metadata inside the optical container. It adaptively uses gzip when it shrinks the optical payload, renders high-density frames with multi-code grid layouts and an error-corrected color channel, and verifies SHA-256 integrity before offering the received file for download.

<p align="center">
  <img src="docs/receiving.jpg" width="420"
       alt="Phone receiving a 2 MB image over light: decoding the sender's animated QR code" />
</p>
<p align="center"><em>Mid-transfer: a phone pulling data out of the air.</em></p>

## Features

- **High-Throughput Optical Pipeline**: Denser QR frames (up to Version 40), multi-code grid layouts (1x1, 2x1, 2x2, 3x2), 2-bit error-corrected color rendering, and optional auto-backoff adaptive density.
- **Accurate Two-Stage Progress Reporting**: Replaces misleading linear bars with an honest two-stage stepper (`1. Collecting blocks` → `2. Reconstructing file`), real-time unique block collection tracking, and live ETA estimation.
- **Resume-on-Drop**: Interrupted transfers (camera focus loss, tab backgrounding, app switching) automatically resume from IndexedDB local block storage when re-scanning the same session.
- **End-to-End Payload Encryption**: Optional 4-digit PIN / passphrase encryption using Web Crypto API (`AES-GCM` with `PBKDF2` key derivation, 100,000 iterations) encrypts data *before* fountain chunking.
- **Client-Side Transfer History**: Local storage drawer logging up to 50 recent transfer entries (filename, size, type, timestamp, direction, completion status).
- **Progressive Web App (PWA) & Standalone**: Full offline service worker precaching, native PWA install prompt (`beforeinstallprompt`), iOS standalone meta-tags, and single-file zero-dependency offline builds (`dist-standalone/`).
- **Observability & Diagnostics**: Collapsible live diagnostics panel surfacing capture FPS, decode FPS, goodput (KB/s), decode success rate (%), and fountain block metrics.

---

## Threat Model & Payload Encryption

Lumix includes optional PIN-based payload encryption on the Send screen.

### What Encryption Protects Against
- **Optical Interception**: Prevents unauthorized cameras or onlookers from reading or reconstructing the file/text if they record the animated QR stream from a distance or via reflections. Without the 4-digit PIN, the optical stream is cryptographically unreadable.

### What Encryption Does NOT Protect Against
- **Shoulder-Surfing / Physical PIN Exposure**: Anyone who can visually see both the sending screen (where the PIN is set/generated) and the QR code can enter the PIN on their own receiving device.
- **Sender Device Compromise**: Unencrypted file data on the sending machine before transmission remains subject to local device security.

---

## Resume-on-Drop & Session Lifecycle

Lumix automatically persists received fountain blocks in browser IndexedDB (`lumix_resume_db`) keyed by stream identity (`sessionId:k:blockLen:totalLen:payloadFnv`).

- **Same Session Reconnect**: If a receiving phone loses signal, backgrounded tabs are suspended, or the tab reloads mid-transfer, re-scanning the ongoing sender stream re-locks onto the saved session, displays a *"Resuming transfer — X% already collected"* banner, and continues without losing progress.
- **Sender Restart (New Session)**: If the sender configuration or file changes, a new `sessionId` is generated. The receiver detects the stream identity change, cleanly starts a fresh collection session, and leaves existing storage uncorrupted.
- **Completion & Invalidation**: IndexedDB state for the active stream is automatically cleared as soon as file reassembly and SHA-256 verification complete or upon explicit cancellation.

---

## Try It

The hosted site is targeted for [lumix.app](https://lumix.app/); everything below is for running it yourself.

```bash
npm install
npm run dev               # dev server with basic SSL (HTTPS)
npm run serve             # build, then serve the production bundle
npm run demo              # demo mode: locked to bundled payloads
npm test                  # unit test suite and golden wire vectors
npm run build             # build production site → dist/
npm run build:standalone  # build zero-dependency standalone HTML files → dist-standalone/
npm run build:all         # build both hosted site and standalone files
```

`npm run demo` locks the sender to bundled images — no file picker or text box — ideal for unattended kiosk displays.

- On the **sending** device: open `https://localhost:5173/send/`, select a file or type a text snippet. Max screen brightness helps.
- On the **receiving** device: open `https://<lan-ip>:5173/receive/`, accept the self-signed certificate once, tap **Start camera**, and point at the screen.
- Upon completion, file integrity is verified via SHA-256 before download.

---

## Ways to Run It

| Mode | Description | Server Needed? | Offline Access |
|---|---|---|---|
| **Hosted PWA** | Three pages + Service Worker precaching — live at [lumix.app](https://lumix.app/) | Yes (static host) | After first visit / Installed PWA |
| **`lumix-sender.html`** | Single self-contained HTML file (~70 KB) | No | Always (`file://` or HTTP) |
| **`lumix-receiver.html`** | Single self-contained HTML file (~1.3 MB, includes ZXing WASM) | HTTP server recommended | Always (after HTTP load) |

*Note: iOS Safari and Android Chrome require HTTPS or a local HTTP server for `getUserMedia` camera permissions; opening `lumix-receiver.html` directly from a local `file://` URI on mobile browsers will block camera access.*

---

## Diagnostics & Observability

Both pages include collapsible **Settings** and **Live Diagnostics** panels:
- **Sender Settings**: FPS control (10–120), Bytes per frame (200–2953), Grid layout mode (1x1 to 3x2), Color mode (B&W or 2-bit Color), Adaptive Density auto-backoff, ECC level (L/M/Q/H), and Encryption PIN generator.
- **Receiver Diagnostics**: Displays live metrics for Capture FPS, Decode FPS, Goodput (KB/s), Decode Success Rate (%), Elapsed Time, Unique/Duplicate Frame counts, and Fountain Block parameters ($K$, block length, total payload).

---

## How It Works

1. **Luby Transform Fountain Coding**: Each frame is the XOR sum of a pseudorandom subset of blocks chosen via a robust-soliton distribution. The receiver collects any $\sim K \cdot 1.15$ distinct frames in any order to decode the full payload.
2. **Self-Describing Frame Headers**: 20-byte packed header carrying session ID, sequence number, block count/length, file length, and FNV-1a checksum.
3. **WASM Decode Pipeline**: Multi-symbol barcode scanning powered by `zxing-cpp` compiled to WebAssembly, running inside dedicated worker threads fed by `requestVideoFrameCallback`.

---

## License

MIT

