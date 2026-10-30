# Dolly: build spec

Status: draft for approval. No app code gets written until this is approved.

Dolly is a screen recorder for macOS and Windows. Stop recording and the video is already polished: a zoom on every click, a smooth cursor, a wallpaper with padding. The editor is **Three-Up**: one edit, three live shapes (16:9, 1:1, 9:16), tick what you want and export them together. See `concepts/5-three-up.html`.

## 1. Decisions worth checking

These are the choices the brief doesn't settle. Say so if you want any of them changed.

| # | Decision | Why | Cost |
|---|---|---|---|
| D1 | Capture runs in a small native helper per OS: Swift + ScreenCaptureKit on macOS, C++ + Windows Graphics Capture on Windows | The real cursor must be left out of the recording or the smoothed cursor shows twice. Both native APIs have a switch for it (`showsCursor`, `IsCursorCaptureEnabled`). Electron documents no such option | Two extra small programs to build and maintain. Mic and webcam still go through Chromium |
| D2 | One `compose(t)` function draws both the preview and the export | Preview and export can't drift apart, and zooms land on the same frame in both | Export is decode → draw → encode, so slower than plain FFmpeg filters |
| D3 | `/api/validate` returns a signed token as well as valid / invalid | With a plain "valid" flag in a file, editing that file unlocks Pro. A signed token is tied to the device, checked offline with Node's built-in Ed25519, and adds no dependency | One extra Vercel env var |
| D4 | Validate once, never re-check | Matches "validate once online". The app makes no background calls | A refunded key keeps working on devices that already activated |
| D5 | Whisper `base` multilingual model (148 MB) and the Silero VAD model (under 1 MB) ship inside the installer | A first-run download would add a second network host, and the brief allows only the license check | Installers grow to an estimated 300 MB, including for Free users |
| D6 | macOS arm64 and Windows x64 only | That's what `macos-latest` and `windows-latest` build natively | No Intel Mac or Windows ARM build, so the landing page must change |
| D7 | Whole-display recording only in v1 | Keeps cursor mapping and the "every zoom lands on a click" check exact | Single-window recording comes later |
| D8 | Several ticked shapes export one after another, using one job queue | Smallest way to deliver Three-Up's "Export 2 files" | Three shapes take about three times as long |

## 2. Free and Pro

| | Free (MIT, forever) | Pro ($9.99 once) |
|---|---|---|
| Recordings | Unlimited, no time limit | Same |
| Auto-zoom, smooth cursor | Yes | Same |
| Backgrounds and padding | Built-in wallpapers | Plus your own images |
| Shapes | 16:9, 1:1, export together | Plus 9:16 |
| Export | MP4 H.264, up to 1080p, 30 fps | Plus 4K, 60 fps, GIF |
| Watermark | None | None |
| Webcam bubble | Shown, locked | Yes |
| Captions | Shown, locked | Yes, on-device |
| Devices | n/a | 3 per key |

Rules:
- Locked items stay visible with a small Pro badge. Clicking one opens the upgrade sheet. The vertical preview stays live and dimmed, with a "Preview only" label.
- No other prompts exist: no banners, launch popups, countdowns or export interruptions.
- The check lives in one place: `can(feature)` in `src/shared/entitlements.ts`. The UI reads it, and the export job checks it again.
- A project that used a Pro feature still opens for free users. The Pro item is kept but left out of the export, and the app says which item in one line.

## 3. Features

### Recording
- Home window: choose display, mic on or off, webcam on or off (Pro), Record.
- 3-second countdown. Stop from the menu bar or tray icon, or with `Cmd/Ctrl+Shift+2`. A stop from the tray ends the video where the menu opened, so the menu never shows in the preview or an export.
- First run explains each permission before the OS asks for it. If one is missing, Dolly opens the right settings page.
- macOS needs Screen Recording, Input Monitoring (global clicks), Microphone and Camera. Windows needs mic and camera only.
- Global clicks come from the capture helper on macOS: a listen-only, mouse-only event tap on its own thread, stamped with the same clock as the frames, written to `mouse.jsonl` and read into `cursor.jsonl` when recording stops. No keyboard event is in its mask. Accessibility isn't needed: macOS checks Input Monitoring for this tap, even with no keyboard events in it. If the tap is unavailable or goes quiet, Dolly polls the cursor position and warns that clicks are missing. "Record without automatic zooms" opens no tap at all: the helper only gets `--mouse-log` when clicks are on and Input Monitoring is granted, and otherwise Dolly polls.
- Windows uses `uiohook-napi` for global clicks. macOS never loads it, because stopping it there can deadlock.
- Recording needs 1 GB free to start, and stops by itself with 300 MB left so there's room to finish. On macOS that counts space the system can purge, which only the helper can see, and it's asked only when `statfs` says there isn't enough. On macOS the mp4 is written in 2 s fragments, so a disk that fills anyway, or a crash, keeps everything up to the last whole fragment. On Windows the file is finalized when a write fails. Finalizing needs a little space, so the stop at 300 MB is what protects a recording there. If finalizing fails too, the file has no index and won't open, and Dolly says so rather than promising a saved recording.
- A display too large for the H.264 encoder is scaled to fit 4096 × 2304 before encoding. macOS asks the encoder first, and Windows applies that limit directly. A Windows PC going to sleep ends the recording where it slept. The gap between QPC and `QueryUnbiasedInterruptTime` is what tells sleep from a stall, and a stall doesn't end it. macOS's capture clock stops during sleep, so nothing jumps there. A resolution change on Windows ends the recording with a warning, since the file, the textures and the cursor map are all sized for the old one.

### Auto-zoom
- One zoom per click group. Clicks under 1.2 s apart merge into one group.
- Default level 2.0×, ease in and out 0.6 s with cubic ease-in-out.
- A segment starts 0.6 s before its first click, so the camera arrives on the click, and ends 1.6 s after its last click (1.0 s hold, 0.6 s ease out).
- Clicks in the first 0.6 s use a shorter ease in. Segments are clamped to the recording.
- If two groups would overlap, the first ends where the next starts and the camera pans between them without zooming out.
- Focus follows the group's clicks and is clamped so the frame never shows past the edge of the canvas, in any shape.
- Editing: drag to move, drag an end to stretch, Delete to remove, `+ Add zoom` at the playhead, drag the focus on the 16:9 preview. Level and ease are set per block.

### Cursor smoothing
- Spring, not linear: stiffness 170, damping 26, mass 1, set by a Smoothness slider.
- It runs offline over the whole recording, so it can look ahead.
- The cursor is pulled to the true position over the 80 ms before each click, so it never misses the thing being clicked.
- The cursor is drawn from Dolly's own vector shape at any resolution, with a short ripple on click.
- Turning smoothing off draws the raw recorded path.

### Three-Up canvas
- 16:9 is the composition: wallpaper, padded screen, rounded corners, shadow.
- At rest, 1:1 and 9:16 fit the screen to the frame width over the wallpaper.
- At full zoom, every shape shows the same slice of screen: `screen height on canvas = frame height × level`. That's what the concept shows, and it means 2.0× means the same thing in all three.
- All three share one timeline. Each shape clamps its own camera to its own edges.
- Below 1100 px window width the previews stack into tabs.

### Webcam bubble (Pro)
Circle or rounded square, any corner, size slider. Shrinks by a third while zoomed so it stays clear of the action.

### Captions (Pro)
- whisper.cpp runs locally after recording when the user turns captions on. No network.
- Language auto-detect, editable lines on a Captions lane, burned into the export.
- Mic only. System audio is not recorded in v1.

### Export
- MP4 H.264 + AAC, or GIF. 1080p or 4K. 30 or 60 fps. Any ticked shapes.
- 1080p means the short side is 1080 (1920×1080, 1080×1080, 1080×1920). 4K means the short side is 2160.
- GIF is limited to 720 px on the long side and 15 fps, so it stays small enough for a README.
- Default folder `~/Movies/Dolly` or `%USERPROFILE%\Videos\Dolly`. Changeable, remembered.
- Progress per file, Cancel, and Reveal in Finder/Explorer. A failed job leaves no partial file.

### Licensing
See section 6.

## 4. Stack and dependencies

Exact versions get pinned in `package.json`.

| Dependency | Size | Purpose | Approval |
|---|---|---|---|
| Electron | Over 5 MB | App shell | In your stack |
| ffmpeg-static (Windows), FFmpeg n7.1.5 + x264 built from pinned source (macOS) | Over 5 MB | Decode and encode | Named exception |
| whisper.cpp v1.9.5, built from source in CI | Binary plus 148 MB model | Captions | Named exception |
| uiohook-napi | 1.2 MB, MIT | Global mouse events, Windows only | Under the limit |
| React, TypeScript, Vite, electron-builder | Dev-time or small | UI and build | Part of the stack, or dev-only |

Nothing else over 5 MB is planned. I'll ask before adding one.

FFmpeg is GPL. That doesn't change Dolly's MIT license, because FFmpeg runs as a separate program, but the app must ship its license and a pointer to its source. Both go in `LICENSES/` and the README. ffmpeg-static's macOS binary is built with `--enable-nonfree` and can't be redistributed, so `native/ffmpeg` builds a smaller one from pinned sources, and the build fails if the result isn't redistributable.

Fonts are bundled from Fontsource under the OFL. `uiohook-napi` contains LGPL code and stays a separate replaceable file in the Windows build. The macOS build doesn't include it. Licenses are in `LICENSES/`.

## 5. File layout

```text
dolly/
  SPEC.md  README.md  LICENSE  package.json
  concepts/                     Design concepts, kept for reference
  native/
    mac-capture/                Swift helper (ScreenCaptureKit, mouse event tap)
    win-capture/                C++ helper (Windows Graphics Capture)
    whisper/                    Pinned build script
  src/
    shared/
      config.ts                 Whop URL, product ID, validate endpoint, public key
      entitlements.ts           can(feature)
      project.ts                Data model below
      compose.ts                Pure frame maths: camera, cursor, layout at time t
    main/
      index.ts  capture.ts  input.ts  permissions.ts
      export.ts  captions.ts  license.ts  network-guard.ts
    preload/index.ts recorder.ts export.ts
    renderer/
      home/  editor/            Three-Up, timeline, inspector
      gl/                       WebGL drawing of a compose() frame
      upgrade/                  Upgrade sheet
    engine/
      zoom.ts                   Clicks to zoom segments
      cursor.ts                 Spring smoothing
  api/validate.ts               Vercel function
  tests/                        Unit tests and the real-recording check
  .github/workflows/release.yml
  LICENSES/
```

## 6. Licensing

**Config.** `src/shared/config.ts` holds `WHOP_URL`, `WHOP_PRODUCT_ID`, `VALIDATE_ENDPOINT` and `LICENSE_PUBLIC_KEY`. No secret goes in the app.

**Vercel env variables.** `WHOP_API_KEY` needs `member:basic:read`, `member:email:read` and `member:manage`. `WHOP_PRODUCT_ID` and `LICENSE_SIGNING_KEY` (Ed25519 private) sit beside it.

**`POST /api/validate`**

```jsonc
// Request
{ "key": "XXXX-XXXX", "deviceId": "16 hex chars" }

// Success
{ "valid": true, "token": "<signed>" }

// Failure
{ "valid": false, "reason": "invalid_key" | "inactive" | "wrong_product" | "device_limit" }
```

Flow, per Whop's current docs:
1. Reject malformed input with no Whop call. A key is any URL-safe characters, and a `mem_` ID is refused by its prefix.
2. `GET https://api.whop.com/api/v1/memberships/{key}`. This path accepts a license key, and an unknown key returns 404, which maps to `invalid_key`.
3. Require `status` to be `active`, `trialing`, `completed` or `canceling`, otherwise `inactive`. A `canceling` member keeps access until the period ends.
4. Require `product.id` to match `WHOP_PRODUCT_ID`, otherwise `wrong_product`.
5. Read device IDs from `metadata.hwid`, stored as a comma-separated list. A listed device passes. A new device with fewer than 3 listed gets added. Otherwise `device_limit`.
6. To add a device, `PATCH /memberships/{mem_id}` using the `mem_` ID from step 2, sending the whole metadata object with the new list.
7. Whop has no compare-and-set, so read the membership again after the PATCH, twice, with 1.6 to 2 s before each read. Continue only if both reads show the same list, with this device in it and within the limit. Otherwise retry a few times with jitter, then answer 503 with no token. A device that's already listed passes at step 5 with no wait. The whole request has 9 s, and the app waits 15 s for it.
8. Sign `{ keyHash, deviceId, iat }` and return the token.

Details that matter:
- Whop's guide says update merges metadata, while the API reference says it replaces it. Sending the full object is correct under both.
- `hwid` is the key Whop's docs use, so a customer reset from their Whop orders should free all 3 slots. That's unconfirmed until tested with a real key (A15).
- A 3-device list fits Whop's 500-character value limit.
- Step 7 narrows the race rather than closing it. With PATCHes of 200 to 3000 ms, 8 staggered requests never got more than 3 tokens in simulation, but a write that lands after the last read can still drop a device that already has one.
- The function never logs keys and never returns the member's email or any other Whop field.
- The product must have Whop's Software app installed, or memberships carry no license key.

**App side**
- `deviceId` is a salted SHA-256 of the OS machine ID, cut to 16 hex characters.
- Settings has an "Enter license key" field. On success, the token and a hash of the key go to the app's user data folder.
- At startup the token is checked offline against the public key and this device's ID. A copied or edited file fails.
- If the server can't be reached: "Couldn't reach the license server. Try again when you're online." Nothing else changes.
- A 429, a machine ID that can't be read and a license that can't be saved each get their own sentence, because none of them mean the user is offline.
- Each failure reason gets one plain sentence. `device_limit` explains how to free a device from Whop.

**Open-core limit.** All code is MIT and public, so anyone can build a copy with Pro switched on. The check stops casual sharing, not determined people. That comes with your model.

## 7. Data model

Each project is a folder, `<Dolly folder>/<name>.dolly/`, holding `project.json`, `cursor.jsonl`, and media.

```ts
type Ms = number                    // Milliseconds from recording start, capture clock
type Px = number                    // Pixels in the screen clip

interface Project {
  version: 1
  id: string
  name: string
  createdAt: string                 // ISO 8601
  durationMs: Ms
  clips: Clip[]
  zooms: ZoomSegment[]
  look: Look
  cursor: CursorStyle
  webcam: WebcamStyle | null        // Pro
  captions: Caption[]               // Pro
  output: OutputSettings
}

interface Clip {
  id: string
  kind: 'screen' | 'mic' | 'webcam'
  file: string                      // Relative to the project folder
  startMs: Ms                       // Offset against the capture clock
  durationMs: Ms
  width?: Px
  height?: Px
  fps?: number
  scaleFactor?: number              // Screen points to pixels
}

// One JSON object per line in cursor.jsonl. Kept out of project.json for size
interface CursorEvent {
  t: Ms
  x: Px
  y: Px
  kind: 'move' | 'down' | 'up'
  button?: 'left' | 'right' | 'middle'
}

interface ZoomSegment {
  id: string
  startMs: Ms
  endMs: Ms
  level: number                     // Default 2.0
  easeInMs: Ms                      // Default 600
  easeOutMs: Ms                     // Default 600
  focus: { x: number; y: number }   // 0 to 1 across the screen clip
  clickMs: Ms[]                     // Clicks merged here, empty for manual zooms
  origin: 'auto' | 'manual'
  edited: boolean                   // True once the user changes it
}

interface Look {
  background:
    | { kind: 'wallpaper'; id: string }
    | { kind: 'image'; file: string }  // Pro
  paddingPct: number                // Default 6
  cornerRadiusPct: number
  shadow: number
}

interface CursorStyle {
  smooth: boolean
  stiffness: number                 // Default 170
  damping: number                   // Default 26
  scale: number
  clickRipple: boolean
}

interface WebcamStyle {
  shape: 'circle' | 'rounded'
  corner: 'tl' | 'tr' | 'bl' | 'br'
  sizePct: number
}

interface Caption {
  id: string
  startMs: Ms
  endMs: Ms
  text: string
}

type Shape = '16:9' | '1:1' | '9:16'   // 9:16 is Pro

interface OutputSettings {
  shapes: Shape[]
  format: 'mp4' | 'gif'             // gif is Pro
  resolution: '1080p' | '4k'        // 4k is Pro
  fps: 30 | 60                      // 60 is Pro
  folder: string
}
```

Rules:
- `engine/zoom.ts` is a pure function from clicks to segments. Regenerating never overwrites a segment where `edited` is true.
- `compose.ts` is pure: same project and time, same frame description.
- Screen frames carry timestamps from the native capture clock. Input events and mic/webcam clips are converted to that clock.

## 8. Build plan

After approval, one subagent per area:

| Agent | Owns | Done when |
|---|---|---|
| Capture | `native/*`, `main/capture.ts`, `input.ts`, `permissions.ts` | Screen, mic, webcam and input log share one clock. Cursor is absent from the frames |
| Zoom engine | `engine/zoom.ts`, zoom parts of `compose.ts` | Unit tests cover merge, overlap, edges and clamping in all shapes |
| Cursor | `engine/cursor.ts` | Spring tests pass, clicks are hit exactly |
| Editor UI | `renderer/*`, except upgrade | Three-Up works. Blocks drag, stretch and delete |
| Export | `main/export.ts`, `renderer/gl` | Every shape, format, size and frame rate exports |
| Captions | `main/captions.ts`, `native/whisper` | Works with networking turned off |
| Licensing | `api/`, `main/license.ts`, `entitlements.ts`, `renderer/upgrade` | Fake key rejected, cached token works offline |
| Installers | `electron-builder` config, `release.yml` | `.dmg` and `.exe` attached to a tagged release |

`src/shared/project.ts` and `compose.ts` get written first, before the agents start, because every area depends on them.

A separate review agent then covers capture, file-writing and licensing: macOS permissions, Windows Graphics Capture, where files get written, secrets, and network use. Everything it finds gets fixed.

## 9. Privacy and safety rules

- No account, telemetry, analytics, crash upload or auto-update. Nothing that phones home.
- `network-guard.ts` blocks every request except `VALIDATE_ENDPOINT` and local app content. Tests prove it.
- The Whop page and README links open in the system browser through `shell.openExternal`, with an allowlist.
- Fonts and all assets are bundled.
- Renderers run with context isolation and sandboxing on, no Node integration, and a strict CSP. The preload exposes named methods only.
- Files are written only to the project folder, the chosen export folder, the app's user data folder and the OS temp folder, which gets cleaned up.
- File paths from the renderer are checked against those folders.

## 10. Installers and README

- `release.yml` runs on every `v*` tag: build `.dmg` on `macos-latest` and `.exe` on `windows-latest`, attach both to the GitHub release.
- Builds are unsigned. The macOS app gets an ad-hoc signature, because Apple silicon refuses to run unsigned code otherwise.
- README: screenshots, build steps, Free vs Pro table, and how to open an unsigned build on macOS (`xattr`, or Open Anyway in Privacy & Security) and Windows (SmartScreen, More info, Run anyway).

Ad-hoc signed builds can lose macOS permissions when the app updates, so users may have to grant them again. The README says so.

## 11. Acceptance checks

### Automated, in CI or locally
- **A1** Unit tests pass for zoom, cursor, compose, entitlements and the validate function, using a mocked Whop.
- **A2** Clicks under 1.2 s apart merge. Clicks 1.2 s or more apart stay separate. A click on the first or last frame is handled.
- **A3** At every frame of a generated test, in all three shapes, at any level, the camera stays inside the canvas.
- **A4** The smoothed cursor is within 4 px of the true position at every click.
- **A5** With a mocked server: valid key unlocks, each failure reason keeps Pro locked, a 4th device gets `device_limit`, and a listed device passes again.
- **A6** Editing the cached token, or copying it to another device ID, leaves Pro locked.
- **A7** A scan of the built app and the bundle finds no Whop API key or signing key.
- **A8** The network guard blocks a test request to any other host.
- **A9** `.dmg` and `.exe` both build in GitHub Actions from a tag and attach to the release.

### Real runs on this Mac
- **A10** Record 20 s with scripted clicks and speech, then export 1080p60 MP4. `ffprobe` confirms 1920×1080, 60 fps, about 20 s, H.264 and AAC.
- **A11** Every click has a zoom. At each click time, a frame sampled from the export shows 2.0× framing on the click position, compared with what `compose()` predicts for that frame.
- **A12** No system cursor appears in the screen clip.
- **A13** The 16:9, 1:1 and 9:16 exports each have the right dimensions, at 1080p and 4K, and a GIF exports.
- **A14** Captions match a known spoken script at 90% of words or better, with Wi-Fi off.
- **A15** With a real key: Pro unlocks, keeps working offline after a restart, a fourth device is refused, and a Whop customer reset frees the slots.
- **A16** A fake key is rejected against the deployed `/api/validate`, and Pro stays locked.

### Needs a real Windows PC
- **A17** A10 to A14 on Windows. CI proves it builds, but this Mac can't run it and a CI runner may have no usable desktop to capture. Until someone runs it on a real PC, Windows capture counts as untested.

## 12. Needed from you

Build can start without these, but "done" can't be reached without them.

1. **A home for the project.** Approve moving it out of the Scrollo repo. I suggest `~/Desktop/dolly`, as its own git repo.
2. **A GitHub repo** for Dolly. `gh` isn't installed here, so I'd also need it installed and signed in, or the repo created for me.
3. **Whop:** the `prod_` product ID, the Software app installed on the product, an API key with the three permissions above, and one real test key.
4. **Vercel:** a project for `/api/validate`, where you add the env variables so the secrets never pass through me.
5. **The Screen Studio screenshots,** if you still want the editor matched to them.
6. **macOS permissions for the test run:** Screen Recording, Input Monitoring, Microphone. Step 6 is a real recording of this screen, so the screen will be captured for 20 s.

## 13. Landing page changes

The page needs these edits before it goes live:

| Page says | Should say |
|---|---|
| "Signed .dmg" | Unsigned, with a link to the README steps |
| "keep Pro on every computer you own", "Pro works on all your computers" | Up to 3 devices |
| "Apple silicon and Intel" | Apple silicon |
| "x64 and ARM64" | x64 |
| "24 wallpapers" | The real number, once it exists |
| "Your window sits on a wallpaper" | "Your screen" until window recording exists |
| `your-name/dolly` | The real repo |

## 14. Not in v1

Single-window recording, system audio, trimming or cutting, Linux, Intel Macs, Windows ARM, auto-update, cloud sharing, license transfer inside the app.

Follow-up for Windows: write fragmented MP4, as macOS does, so a disk that fills past the 300 MB stop or a crash keeps what was written. It needs a real PC to prove, since the Windows helper has never been compiled here.

## Sources

- [Whop: license keys in SaaS](https://docs.whop.com/supported-business-models/saas)
- [Whop: retrieve membership](https://docs.whop.com/api-reference/memberships/retrieve-membership)
- [Whop: update membership](https://docs.whop.com/api-reference/memberships/update-membership)
- [Electron: desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Electron issue #14337: hide cursor while capturing](https://github.com/electron/electron/issues/14337)
