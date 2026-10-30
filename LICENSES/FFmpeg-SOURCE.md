# FFmpeg source

Dolly runs FFmpeg as a separate program and doesn't link against it, so FFmpeg's license doesn't change Dolly's. The FFmpeg binaries themselves are GPL.

## macOS arm64

Dolly builds this binary itself with `native/ffmpeg/build.mjs`, which is the complete build recipe. It's licensed GPL v2 or later, and its license is in `FFmpeg-GPL-2.0.txt`. It contains:

- FFmpeg 7.1.5, commit [3a0867c2bf](https://github.com/FFmpeg/FFmpeg/commit/3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587), unmodified, tag [n7.1.5](https://github.com/FFmpeg/FFmpeg/releases/tag/n7.1.5)
- x264, commit [b35605ace3](https://code.videolan.org/videolan/x264/-/commit/b35605ace3ddf7c1a5d67a2eb553f034aef41d55), unmodified, GPL v2 or later

The build uses no `--enable-nonfree`, and it fails if the result reports itself as not redistributable.

## Windows x64

This binary comes from the npm package [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 5.3.0, [release b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1). Dolly doesn't modify it.

- Built by [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), version `6.1.1-essentials_build-www.gyan.dev`, license GPL v3
- Source: <https://github.com/FFmpeg/FFmpeg/commit/e38092ef93>, or tag [n6.1.1](https://github.com/FFmpeg/FFmpeg/releases/tag/n6.1.1)
- Build notes: <https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/win32-x64.README>

## External libraries

The Windows binary is static and includes third-party libraries such as x264 and x265. Their sources are published by their own projects. Its license is in `FFmpeg-GPL-3.0.txt` and `FFmpeg-LICENSE.md`.
