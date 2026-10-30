// dolly-capture: records one display to an H.264 mp4 with no cursor in the frames.
//
//   dolly-capture record --display <id> --output <path> [--fps 60] [--mouse-log <path>]
//   dolly-capture mouse-tap --seconds <n> --output <path>
//   dolly-capture disk-free --path <path>
//   dolly-capture permission
//   dolly-capture request-permission
//   dolly-capture request-mouse-permission
//
// stdout is JSON lines: ready, firstFrame, pong, tapLost, stopped, diskFree, error, permission.
// stdin takes lines: "stop" finalizes the file, "ping" answers with the host clock. EOF means stop.
// Host time is the clock frames are stamped with, so firstFrame.hostMs is t=0 for the whole recording.
// --mouse-log records the mouse to that file on the same clock, one JSON line per event: h is host ms, k is
// m, d or u, x and y are screen points, b is the button (1 left, 2 right, 3 middle, higher for side buttons).
// mouse-tap runs that tap alone, with no capture, so it can be checked without recording the screen.
// disk-free answers with the bytes a volume can give to something important, counting what macOS can purge.

import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import VideoToolbox

// Never use FileHandle here: it raises on a closed pipe, and a parent that died must not stop finalization
func emit(_ fields: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else { return }
  var line = data
  line.append(0x0A)
  line.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let n = write(STDOUT_FILENO, raw.baseAddress! + offset, raw.count - offset)
      if n <= 0 { return }
      offset += n
    }
  }
}

func hostNow() -> CMTime {
  CMClockGetTime(CMClockGetHostTimeClock())
}

func ms(_ time: CMTime) -> Double {
  CMTimeGetSeconds(time) * 1000
}

func fail(_ message: String, code: String = "capture") -> Never {
  emit(["type": "error", "message": message, "code": code])
  exit(1)
}

func evenDown(_ v: Int) -> Int {
  v & ~1
}

// Native backing pixels. Points times scale factor, whatever the "looks like" setting is
func nativeSize(of id: CGDirectDisplayID) -> (width: Int, height: Int) {
  if let mode = CGDisplayCopyDisplayMode(id), mode.pixelWidth > 0 {
    return (mode.pixelWidth, mode.pixelHeight)
  }
  return (CGDisplayPixelsWide(id), CGDisplayPixelsHigh(id))
}

func h264Bitrate(width: Int, height: Int, fps: Int) -> Int {
  let wanted = Double(width * height * fps) * 0.08
  return Int(min(60_000_000, max(12_000_000, wanted)))
}

func writerSettings(width: Int, height: Int, fps: Int) -> [String: Any] {
  [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoColorPropertiesKey: [
      AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
      AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
      AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2
    ],
    AVVideoCompressionPropertiesKey: [
      AVVideoAverageBitRateKey: h264Bitrate(width: width, height: height, fps: fps),
      AVVideoExpectedSourceFrameRateKey: fps,
      AVVideoMaxKeyFrameIntervalKey: fps * 2,
      AVVideoAllowFrameReorderingKey: false,
      AVVideoProfileLevelKey: kVTProfileLevel_H264_High_AutoLevel as String
    ] as [String: Any]
  ]
}

// Mouse only and listen only. There's no keyboard event in this mask, so a keystroke can't reach this process
let mouseEventTypes: [CGEventType] = [
  .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
  .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp
]

// One check's verdict on the tap. Only events arriving clear the count, because a still second proves nothing:
// a dead tap and a mouse at rest look the same
func silentChecksAfter(_ count: Int, enabled: Bool, moved: Bool, arrived: Bool) -> Int {
  if !enabled || (moved && !arrived) { return count + 1 }
  return arrived ? 0 : count
}

enum TapState: String {
  case listening // On and enabled
  case disabled // Created, but macOS left it off, which is what a missing permission looks like
  case unavailable // tapCreate returned nil, or the log couldn't be opened
  case lost // Was listening, then stopped reporting
}

let mouseTapCallback: CGEventTapCallBack = { _, type, event, info in
  if let info { Unmanaged<MouseTap>.fromOpaque(info).takeUnretainedValue().handle(type, event) }
  return Unmanaged.passUnretained(event)
}

// Runs on its own thread and CFRunLoop, so a busy capture queue can't delay it. Events are stamped on arrival
// with hostNow, because that's the clock firstFrame uses and CGEvent.timestamp isn't documented to be
final class MouseTap: @unchecked Sendable {
  private static let silentChecksToLose = 3

  private let path: String
  private var file: UnsafeMutablePointer<FILE>?
  private var tap: CFMachPort?
  private var loop: CFRunLoop?
  private var lastPoint = CGPoint.zero
  private var seenAtLastCheck = 0
  private var silentChecks = 0
  private var state = TapState.unavailable
  private var events = 0
  private var disabledNotices = 0

  init(path: String) {
    self.path = path
  }

  func start() -> TapState {
    let started = DispatchSemaphore(value: 0)
    let thread = Thread { [self] in run(started) }
    thread.qualityOfService = .userInteractive
    thread.start()
    // A recording shouldn't wait on the mouse. If this runs out, ready says unavailable and main polls
    _ = started.wait(timeout: .now() + 2)
    return state
  }

  private func run(_ started: DispatchSemaphore) {
    file = fopen(path, "w")
    let mask = mouseEventTypes.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    guard file != nil,
          let created = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: mouseTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
          ) else {
      started.signal()
      return
    }
    tap = created
    loop = CFRunLoopGetCurrent()
    CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(nil, created, 0), .commonModes)
    CGEvent.tapEnable(tap: created, enable: true)
    var tries = 0
    while !CGEvent.tapIsEnabled(tap: created), tries < 4 {
      CFRunLoopRunInMode(.defaultMode, 0.05, false)
      tries += 1
    }
    state = CGEvent.tapIsEnabled(tap: created) ? .listening : .disabled
    lastPoint = CGEvent(source: nil)?.location ?? .zero
    let timer = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 1, 1, 0, 0) { [self] _ in check() }
    CFRunLoopAddTimer(CFRunLoopGetCurrent(), timer, .commonModes)
    started.signal()
    CFRunLoopRun()
  }

  fileprivate func handle(_ type: CGEventType, _ event: CGEvent) {
    let kind: String
    var button: Int64 = 0
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
      disabledNotices += 1
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return
    case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
      kind = "m"
    case .leftMouseDown:
      (kind, button) = ("d", 1)
    case .leftMouseUp:
      (kind, button) = ("u", 1)
    case .rightMouseDown:
      (kind, button) = ("d", 2)
    case .rightMouseUp:
      (kind, button) = ("u", 2)
    case .otherMouseDown:
      (kind, button) = ("d", event.getIntegerValueField(.mouseEventButtonNumber) + 1)
    case .otherMouseUp:
      (kind, button) = ("u", event.getIntegerValueField(.mouseEventButtonNumber) + 1)
    default:
      return
    }
    events += 1
    guard let file else { return }
    let at = event.location
    let pressed = button > 0 ? ",\"b\":\(button)" : ""
    // A full disk shows up in the video first, so a failed write here can pass quietly
    fputs(String(format: "{\"h\":%.3f,\"k\":\"\(kind)\",\"x\":%.2f,\"y\":%.2f\(pressed)}\n", ms(hostNow()), at.x, at.y), file)
  }

  // Once a second on the tap's thread. Flushes the log and looks for a tap that went quiet: macOS can switch one
  // off, or leave it on and send nothing. The cursor position needs no permission, so it's the witness
  private func check() {
    if let file { fflush(file) }
    guard let tap else { return }
    if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
    let point = CGEvent(source: nil)?.location ?? lastPoint
    silentChecks = silentChecksAfter(
      silentChecks,
      enabled: CGEvent.tapIsEnabled(tap: tap),
      moved: point != lastPoint,
      arrived: events != seenAtLastCheck
    )
    lastPoint = point
    seenAtLastCheck = events
    if state == .listening, silentChecks >= MouseTap.silentChecksToLose {
      state = .lost
      emit(["type": "tapLost"])
    }
  }

  // Closes the log, so it's whole before anyone hears the recording stopped
  func finish() -> [String: Any] {
    let finished = DispatchSemaphore(value: 0)
    if let loop {
      CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) { [self] in
        if let tap {
          CGEvent.tapEnable(tap: tap, enable: false)
          CFMachPortInvalidate(tap)
        }
        closeFile()
        CFRunLoopStop(loop)
        finished.signal()
      }
      CFRunLoopWakeUp(loop)
      _ = finished.wait(timeout: .now() + 1)
    } else {
      closeFile()
    }
    return ["mouseTap": state.rawValue, "tapEvents": events, "tapDisabled": disabledNotices]
  }

  private func closeFile() {
    if let file { fclose(file) }
    file = nil
  }
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let displayID: CGDirectDisplayID
  private let outputURL: URL
  private let fps: Int
  private let mouseLog: String?
  private let frameTime: CMTime
  private let queue = DispatchQueue(label: "dolly.capture", qos: .userInteractive)

  private var stream: SCStream?
  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  private var filler: DispatchSourceTimer?
  private var mouseTap: MouseTap?

  private var firstPts: CMTime?
  private var nextSlot = 0 // Frames sit on an exact 60 fps grid counted from the first frame
  private var lastBuffer: CVPixelBuffer?
  private var frames = 0
  private var repeats = 0
  private var dropped = 0
  private var finishing = false

  init(displayID: CGDirectDisplayID, outputURL: URL, fps: Int, mouseLog: String?) {
    self.displayID = displayID
    self.outputURL = outputURL
    self.fps = fps
    self.mouseLog = mouseLog
    self.frameTime = CMTime(value: 1, timescale: CMTimeScale(fps))
  }

  func start() {
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
      if let error {
        let code = (error as NSError).code == SCStreamError.userDeclined.rawValue ? "permission" : "capture"
        fail("Couldn't read the screen: \(error.localizedDescription)", code: code)
      }
      guard let display = content?.displays.first(where: { $0.displayID == self.displayID }) else {
        fail("That display isn't available. If the Mac is locked or the display is asleep, wake it and try again.", code: "display")
      }
      self.begin(display, applications: content?.applications ?? [])
    }
  }

  private func begin(_ display: SCDisplay, applications: [SCRunningApplication]) {
    var (pixelW, pixelH) = nativeSize(of: displayID)
    pixelW = evenDown(pixelW)
    pixelH = evenDown(pixelH)

    let writer: AVAssetWriter
    do {
      try? FileManager.default.removeItem(at: outputURL)
      writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
    } catch {
      fail("Couldn't create \(outputURL.path): \(error.localizedDescription)", code: "file")
    }
    // Fragments keep what's on disk playable if the disk fills or this process dies, and finishing the file
    // still turns it into a plain mp4. Finishing needs a little space, so a file that can't be finished stays fragmented
    writer.movieFragmentInterval = CMTime(value: 2, timescale: 1)

    // Very large displays can exceed what the H.264 encoder takes. Scale to fit rather than fail
    var settings = writerSettings(width: pixelW, height: pixelH, fps: fps)
    if !writer.canApply(outputSettings: settings, forMediaType: .video) {
      let scale = min(4096.0 / Double(pixelW), 2304.0 / Double(pixelH), 1)
      pixelW = evenDown(Int(Double(pixelW) * scale))
      pixelH = evenDown(Int(Double(pixelH) * scale))
      settings = writerSettings(width: pixelW, height: pixelH, fps: fps)
      if !writer.canApply(outputSettings: settings, forMediaType: .video) {
        fail("H.264 can't encode \(pixelW)x\(pixelH)", code: "encoder")
      }
    }

    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = true
    input.mediaTimeScale = CMTimeScale(fps * 1000)
    guard writer.canAdd(input) else { fail("The encoder refused the video track", code: "encoder") }
    writer.add(input)
    self.writer = writer
    self.input = input
    self.adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)

    let config = SCStreamConfiguration()
    config.width = pixelW
    config.height = pixelH
    config.minimumFrameInterval = frameTime
    config.queueDepth = 6
    config.showsCursor = false
    config.capturesAudio = false
    config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    config.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
    config.colorSpaceName = CGColorSpace.sRGB
    if #available(macOS 14.0, *) { config.captureResolution = .best }

    // Leave Dolly's own windows out, such as the stop bar, even ones that open later. Run by hand, the parent is no app
    let parent = getppid()
    let dolly = applications.first { $0.processID == parent }
    let filter = dolly.map { SCContentFilter(display: display, excludingApplications: [$0], exceptingWindows: []) }
      ?? SCContentFilter(display: display, excludingWindows: [])
    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    do {
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    } catch {
      fail("Couldn't attach to the stream: \(error.localizedDescription)")
    }
    self.stream = stream

    var ready: [String: Any] = [
      "type": "ready",
      "width": pixelW,
      "height": pixelH,
      "fps": fps,
      "displayId": displayID,
      "scaleFactor": Double(pixelW) / Double(display.width),
      "hostMs": ms(hostNow())
    ]
    if let mouseLog {
      let tap = MouseTap(path: mouseLog)
      mouseTap = tap
      ready["mouseTap"] = tap.start().rawValue
      ready["listenAccess"] = CGPreflightListenEventAccess()
    }
    emit(ready)

    stream.startCapture { error in
      guard let error else { return }
      let code = (error as NSError).code == SCStreamError.userDeclined.rawValue ? "permission" : "capture"
      fail("Couldn't start capture: \(error.localizedDescription)", code: code)
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, !finishing, sample.isValid else { return }
    guard let infos = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let raw = infos.first?[.status] as? Int,
          SCFrameStatus(rawValue: raw) == .complete,
          let buffer = sample.imageBuffer else { return }
    let pts = sample.presentationTimeStamp

    if firstPts == nil {
      guard let writer, writer.startWriting() else {
        fail("Couldn't start writing: \(writer?.error?.localizedDescription ?? "unknown")", code: "file")
      }
      writer.startSession(atSourceTime: pts)
      firstPts = pts
      lastBuffer = buffer
      write(buffer, isRepeat: false)
      emit(["type": "firstFrame", "hostMs": ms(pts)])
      startFiller()
      return
    }

    let slot = slotIndex(of: pts)
    // A frame that lands on a used slot waits in lastBuffer, so the filler still shows the newest picture
    if slot >= nextSlot {
      fill(upTo: slot)
      write(buffer, isRepeat: false)
    }
    lastBuffer = buffer
  }

  private func slotIndex(of time: CMTime) -> Int {
    guard let firstPts else { return 0 }
    return Int((CMTimeGetSeconds(CMTimeSubtract(time, firstPts)) * Double(fps)).rounded())
  }

  private func write(_ buffer: CVPixelBuffer, isRepeat: Bool) {
    guard let input, let adaptor, let firstPts else { return }
    let slot = nextSlot
    nextSlot += 1
    guard input.isReadyForMoreMediaData else {
      dropped += 1
      return
    }
    let at = CMTimeAdd(firstPts, CMTimeMultiply(frameTime, multiplier: Int32(slot)))
    guard adaptor.append(buffer, withPresentationTime: at) else {
      // Usually a full disk. The writer is finished after this, but the fragments it wrote still play
      FileHandle.standardError.write(Data("writing a frame failed: \(writer?.error?.localizedDescription ?? "unknown")\n".utf8))
      stop(reason: "write-failed")
      return
    }
    if isRepeat { repeats += 1 } else { frames += 1 }
  }

  // Repeats the last frame into every empty slot before this one
  private func fill(upTo slot: Int) {
    guard let buffer = lastBuffer else { return }
    while nextSlot < slot { write(buffer, isRepeat: true) }
  }

  // ScreenCaptureKit only sends a frame when the picture changes. Repeat the last one so the file is a true
  // constant 60 fps and runs to the real end of the recording. Stay a few frames behind the clock, since real
  // frames arrive slightly late
  private func startFiller() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 1.0 / Double(fps), leeway: .milliseconds(2))
    timer.setEventHandler { [weak self] in
      guard let self, !self.finishing else { return }
      self.fill(upTo: self.slotIndex(of: hostNow()) - 3)
    }
    timer.resume()
    filler = timer
  }

  func stop(reason: String = "requested") {
    queue.async {
      guard !self.finishing else { return }
      self.finishing = true
      self.filler?.cancel()
      let stopAt = hostNow()
      guard let stream = self.stream else { self.finalize(stopAt: stopAt, reason: reason); return }
      stream.stopCapture { _ in
        self.queue.async { self.finalize(stopAt: stopAt, reason: reason) }
      }
    }
  }

  private func finalize(stopAt: CMTime, reason: String) {
    guard let writer, let input, let firstPts else {
      writer?.cancelWriting()
      try? FileManager.default.removeItem(at: outputURL)
      fail("Stopped before any frame arrived", code: "no-frames")
    }
    fill(upTo: slotIndex(of: stopAt) + 1)
    let end = CMTimeAdd(firstPts, CMTimeMultiply(frameTime, multiplier: Int32(nextSlot)))
    let durationMs = ms(CMTimeSubtract(end, firstPts))
    // Never cancel here, as that deletes the file. Main measures what survived, since it ends on a fragment
    guard writer.status == .writing else {
      report(reason: "write-failed", durationMs: durationMs)
    }
    input.markAsFinished()
    writer.endSession(atSourceTime: end)
    writer.finishWriting {
      self.report(reason: writer.status == .completed ? reason : "write-failed", durationMs: durationMs)
    }
  }

  private func report(reason: String, durationMs: Double) -> Never {
    var stopped: [String: Any] = [
      "type": "stopped",
      "reason": reason,
      "durationMs": durationMs,
      "frames": frames,
      "repeats": repeats,
      "dropped": dropped
    ]
    if let tap = mouseTap { stopped.merge(tap.finish()) { _, new in new } }
    emit(stopped)
    exit(0)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    // A display unplugged or the user ending it from the menu bar. Keep what was recorded
    FileHandle.standardError.write(Data("stream stopped: \(error.localizedDescription)\n".utf8))
    self.stop(reason: "interrupted")
  }
}

func value(after flag: String, in args: [String]) -> String? {
  guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
  return args[i + 1]
}

func runRecord(_ args: [String]) -> Never {
  guard let output = value(after: "--output", in: args) else { fail("--output is required", code: "usage") }
  let fps = Int(value(after: "--fps", in: args) ?? "") ?? 60
  guard (1...120).contains(fps) else { fail("--fps out of range", code: "usage") }

  // Touching the display list connects to the window server, which a command line tool has not done yet
  var display = CGMainDisplayID()
  if let raw = value(after: "--display", in: args) {
    guard let id = UInt32(raw) else { fail("--display must be a numeric display ID", code: "usage") }
    display = id
  }

  guard CGPreflightScreenCaptureAccess() else {
    fail("Screen Recording permission is not granted", code: "permission")
  }

  let recorder = Recorder(displayID: display, outputURL: URL(fileURLWithPath: output), fps: fps, mouseLog: value(after: "--mouse-log", in: args))

  signal(SIGPIPE, SIG_IGN)
  signal(SIGTERM, SIG_IGN)
  signal(SIGINT, SIG_IGN)
  let signals = [SIGTERM, SIGINT].map { sig -> DispatchSourceSignal in
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
    source.setEventHandler { recorder.stop() }
    source.resume()
    return source
  }

  Thread.detachNewThread {
    while let line = readLine() {
      let command = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if command == "stop" {
        recorder.stop()
      } else if command == "ping" {
        emit(["type": "pong", "hostMs": ms(hostNow())])
      }
    }
    recorder.stop()
  }

  recorder.start()
  withExtendedLifetime(signals) { dispatchMain() }
}

func runMouseTap(_ args: [String]) -> Never {
  guard let output = value(after: "--output", in: args) else { fail("--output is required", code: "usage") }
  let seconds = Double(value(after: "--seconds", in: args) ?? "") ?? 3
  let tap = MouseTap(path: output)
  let state = tap.start()
  emit(["type": "ready", "mouseTap": state.rawValue, "listenAccess": CGPreflightListenEventAccess(), "hostMs": ms(hostNow())])
  Thread.sleep(forTimeInterval: seconds)
  var stopped: [String: Any] = ["type": "stopped", "listenAccess": CGPreflightListenEventAccess()]
  stopped.merge(tap.finish()) { _, new in new }
  emit(stopped)
  exit(0)
}

func runDiskFree(_ args: [String]) -> Never {
  guard let path = value(after: "--path", in: args) else { fail("--path is required", code: "usage") }
  let keys: Set<URLResourceKey> = [.volumeAvailableCapacityForImportantUsageKey]
  guard let bytes = try? URL(fileURLWithPath: path).resourceValues(forKeys: keys).volumeAvailableCapacityForImportantUsage else {
    fail("Couldn't read the free space of \(path)", code: "file")
  }
  emit(["type": "diskFree", "bytes": bytes])
  exit(0)
}

func runPermission(request: Bool) -> Never {
  let screen = request ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
  emit(["type": "permission", "screen": screen, "mouse": CGPreflightListenEventAccess()])
  exit(0)
}

func runMousePermission() -> Never {
  emit(["type": "permission", "screen": CGPreflightScreenCaptureAccess(), "mouse": CGRequestListenEventAccess()])
  exit(0)
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "record": runRecord(args)
case "mouse-tap": runMouseTap(args)
case "disk-free": runDiskFree(args)
case "permission": runPermission(request: false)
case "request-permission": runPermission(request: true)
case "request-mouse-permission": runMousePermission()
default: fail("usage: dolly-capture record --display <id> --output <path> [--fps 60] [--mouse-log <path>] | mouse-tap --seconds <n> --output <path> | disk-free --path <path> | permission | request-permission | request-mouse-permission", code: "usage")
}
