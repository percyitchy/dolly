# Third-party licenses

Dolly's own code is MIT, see `LICENSE` at the repo root (`Dolly-MIT.txt` in the installed app).

| Component | License | Files | Linked into Dolly |
|---|---|---|---|
| FFmpeg, from ffmpeg-static 5.3.0 | GPL v3 or later | `FFmpeg-GPL-3.0.txt`, `FFmpeg-LICENSE.md`, `FFmpeg-SOURCE.md` | No, runs as a separate program |
| whisper.cpp v1.9.5 | MIT | `whisper.cpp-MIT.txt` | No, runs as a separate program |
| Whisper `base` model | MIT | `whisper-model-MIT.txt` | No, data file |
| Electron 44.7.2 | MIT | `Electron-MIT.txt` | App shell. Chromium's notices ship beside the app as `LICENSES.chromium.html` |
| uiohook-napi 1.5.5 | MIT | `uiohook-napi-MIT.txt` | Windows only, native module |
| libuiohook, compiled into uiohook-napi | LGPL v3 or later | `libuiohook-LGPL-3.0.txt`, `FFmpeg-GPL-3.0.txt` | Windows only, inside the `.node` file, which stays a separate replaceable file in `app.asar.unpacked` |
| node-gyp-build | MIT | `node-gyp-build-MIT.txt` | Windows only, loads uiohook-napi |
| React and React DOM | MIT | `React-MIT.txt` | Yes, bundled into the UI |

The GPL text in `FFmpeg-GPL-3.0.txt` is also the base text the LGPL v3 builds on.

The macOS app doesn't contain uiohook-napi, libuiohook or node-gyp-build. The Swift capture helper records the mouse there instead. Their license files still ship in both installers, because every installer carries this whole folder.
