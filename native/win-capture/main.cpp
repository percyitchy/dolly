// dolly-capture for Windows: records one monitor to an H.264 mp4 with no cursor in the frames.
//
//   dolly-capture record --display <x,y|primary> --output <path> [--fps 60]
//   dolly-capture permission
//   dolly-capture request-permission
//
// Same protocol as the macOS helper. stdout is JSON lines: ready, firstFrame, pong, stopped, error,
// permission. stopped says resolutionChanged when that's what ended the recording. stdin takes lines: "stop" finalizes the file, "ping" answers with the host clock. EOF means stop.
// --display is a physical pixel point inside the monitor, because Electron's display IDs mean nothing to Win32.
// Host time is QPC in ms, the clock GraphicsCaptureFrame stamps frames with.
// ready also says whether Windows hid the real cursor and the yellow border, as older builds can't do either.

#define NOMINMAX
#include <windows.h>
#include <unknwn.h>

#include <d2d1_1.h>
#include <d2d1_1helper.h>
#include <d3d11.h>
#include <dxgi.h>
#include <fcntl.h>
#include <inspectable.h>
#include <io.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <shellscalingapi.h>
#include <timeapi.h>
#include <codecapi.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgd = winrt::Windows::Graphics::DirectX;
namespace wfm = winrt::Windows::Foundation::Metadata;

using winrt::check_hresult;
using winrt::com_ptr;

static std::mutex g_emit_lock;

static std::string json_escape(const std::string& in) {
  std::string out;
  for (char c : in) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      out += ' ';
    } else {
      out += c;
    }
  }
  return out;
}

static void emit_line(const std::string& line) {
  std::lock_guard<std::mutex> hold(g_emit_lock);
  fwrite(line.data(), 1, line.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static std::string utf8(const std::wstring& in) {
  if (in.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, in.c_str(), static_cast<int>(in.size()), nullptr, 0, nullptr, nullptr);
  std::string out(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, in.c_str(), static_cast<int>(in.size()), out.data(), size, nullptr, nullptr);
  return out;
}

[[noreturn]] static void quit(int code) {
  // A plain return would wait on the thread blocked in stdin
  fflush(stdout);
  _exit(code);
}

[[noreturn]] static void fail(const std::string& message, const char* code = "capture") {
  emit_line("{\"type\":\"error\",\"code\":\"" + std::string(code) + "\",\"message\":\"" + json_escape(message) + "\"}");
  quit(1);
}

static int64_t host_now_100ns() {
  LARGE_INTEGER freq;
  LARGE_INTEGER now;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&now);
  const int64_t whole = now.QuadPart / freq.QuadPart;
  const int64_t rest = now.QuadPart % freq.QuadPart;
  return whole * 10000000 + rest * 10000000 / freq.QuadPart;
}

// Like QPC, but this one stops while the PC sleeps, so the gap between them is time spent asleep and nothing else
static int64_t awake_now_100ns() {
  ULONGLONG ticks = 0;
  QueryUnbiasedInterruptTime(&ticks);
  return static_cast<int64_t>(ticks);
}

static std::string host_ms(int64_t ticks) {
  char text[64];
  snprintf(text, sizeof(text), "%.4f", static_cast<double>(ticks) / 10000.0);
  return text;
}

struct FrameSize {
  UINT32 width;
  UINT32 height;
};

// What the H.264 encoders take, the same limits as the macOS helper. Dimensions stay even, which H.264 wants
static FrameSize encode_size(UINT32 width, UINT32 height) {
  const double scale = std::min({4096.0 / width, 2304.0 / height, 1.0});
  return {static_cast<UINT32>(width * scale) & ~1u, static_cast<UINT32>(height * scale) & ~1u};
}

static HMONITOR pick_monitor(const std::wstring& display) {
  int x = 0;
  int y = 0;
  if (display.empty() || display == L"primary") {
    POINT origin{0, 0};
    return MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
  }
  if (swscanf_s(display.c_str(), L"%d,%d", &x, &y) != 2) fail("--display must be x,y or primary", "usage");
  POINT point{x, y};
  HMONITOR monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONULL);
  if (!monitor) fail("That display isn't available. If it's asleep, wake it and try again.", "display");
  return monitor;
}

static double monitor_scale(HMONITOR monitor) {
  UINT dpi_x = 96;
  UINT dpi_y = 96;
  if (FAILED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &dpi_x, &dpi_y))) return 1;
  return dpi_x / 96.0;
}

static com_ptr<ID3D11Device> create_d3d(com_ptr<ID3D11DeviceContext>& context) {
  com_ptr<ID3D11Device> device;
  const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, nullptr, 0, D3D11_SDK_VERSION,
                                 device.put(), nullptr, context.put());
  if (FAILED(hr)) {
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags, nullptr, 0, D3D11_SDK_VERSION, device.put(),
                           nullptr, context.put());
  }
  check_hresult(hr);
  return device;
}

static wgd::Direct3D11::IDirect3DDevice wrap_device(const com_ptr<ID3D11Device>& device) {
  com_ptr<IDXGIDevice> dxgi = device.as<IDXGIDevice>();
  com_ptr<::IInspectable> inspectable;
  check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()));
  return inspectable.as<wgd::Direct3D11::IDirect3DDevice>();
}

static wgc::GraphicsCaptureItem item_for_monitor(HMONITOR monitor) {
  auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  wgc::GraphicsCaptureItem item{nullptr};
  check_hresult(interop->CreateForMonitor(monitor, winrt::guid_of<wgc::IGraphicsCaptureItem>(), winrt::put_abi(item)));
  return item;
}

static com_ptr<ID3D11Texture2D> frame_texture(const wgc::Direct3D11CaptureFrame& frame) {
  auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  com_ptr<ID3D11Texture2D> texture;
  check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void()));
  return texture;
}

// Shrinks frames on the GPU for displays past the encoder's limits. Direct2D rather than the D3D11 video
// processor, because it runs on any device, WARP included, and leaves the colors alone
class Scaler {
 public:
  void open(const com_ptr<ID3D11Device>& device, FrameSize from, FrameSize to) {
    to_ = to;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = from.width;
    desc.Height = from.height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    check_hresult(device->CreateTexture2D(&desc, nullptr, source_.put()));
    desc.Width = to.width;
    desc.Height = to.height;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    check_hresult(device->CreateTexture2D(&desc, nullptr, target_.put()));

    com_ptr<ID2D1Factory1> factory;
    check_hresult(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, factory.put()));
    com_ptr<ID2D1Device> d2d_device;
    check_hresult(factory->CreateDevice(device.as<IDXGIDevice>().get(), d2d_device.put()));
    check_hresult(d2d_device->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE, draw_.put()));

    const D2D1_PIXEL_FORMAT format = D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_IGNORE);
    const D2D1_BITMAP_PROPERTIES1 source_props = D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_NONE, format);
    const D2D1_BITMAP_PROPERTIES1 target_props =
        D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW, format);
    check_hresult(draw_->CreateBitmapFromDxgiSurface(source_.as<IDXGISurface>().get(), &source_props, source_bitmap_.put()));
    check_hresult(draw_->CreateBitmapFromDxgiSurface(target_.as<IDXGISurface>().get(), &target_props, target_bitmap_.put()));
    draw_->SetTarget(target_bitmap_.get());
  }

  // Leaves the scaled picture in output, the same size as to
  void run(const com_ptr<ID3D11DeviceContext>& context, ID3D11Texture2D* frame, const D3D11_BOX& box, ID3D11Texture2D* output) {
    context->CopySubresourceRegion(source_.get(), 0, 0, 0, 0, frame, 0, &box);
    const D2D1_RECT_F whole = D2D1::RectF(0.0f, 0.0f, static_cast<FLOAT>(to_.width), static_cast<FLOAT>(to_.height));
    draw_->BeginDraw();
    draw_->DrawBitmap(source_bitmap_.get(), &whole, 1.0f, D2D1_INTERPOLATION_MODE_LINEAR);
    check_hresult(draw_->EndDraw());
    context->CopyResource(output, target_.get());
  }

 private:
  FrameSize to_{0, 0};
  com_ptr<ID3D11Texture2D> source_;
  com_ptr<ID3D11Texture2D> target_;
  com_ptr<ID2D1DeviceContext> draw_;
  com_ptr<ID2D1Bitmap1> source_bitmap_;
  com_ptr<ID2D1Bitmap1> target_bitmap_;
};

class Mp4Writer {
 public:
  void open(const std::wstring& path, UINT32 width, UINT32 height, UINT32 fps) {
    width_ = width;
    height_ = height;
    fps_ = fps;

    com_ptr<IMFAttributes> attributes;
    check_hresult(MFCreateAttributes(attributes.put(), 1));
    check_hresult(attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE));
    check_hresult(MFCreateSinkWriterFromURL(path.c_str(), nullptr, attributes.get(), writer_.put()));

    const uint64_t pixels = static_cast<uint64_t>(width) * height * fps;
    const uint64_t bitrate = std::min<uint64_t>(60000000, std::max<uint64_t>(12000000, pixels * 8 / 100));

    com_ptr<IMFMediaType> out;
    check_hresult(MFCreateMediaType(out.put()));
    check_hresult(out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    check_hresult(out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264));
    check_hresult(out->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(bitrate)));
    check_hresult(out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
    check_hresult(out->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High));
    check_hresult(MFSetAttributeSize(out.get(), MF_MT_FRAME_SIZE, width, height));
    check_hresult(MFSetAttributeRatio(out.get(), MF_MT_FRAME_RATE, fps, 1));
    check_hresult(MFSetAttributeRatio(out.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));
    check_hresult(writer_->AddStream(out.get(), &stream_));

    // RGB32 with a negative stride is bottom-up, which is why push() flips the rows
    com_ptr<IMFMediaType> in;
    check_hresult(MFCreateMediaType(in.put()));
    check_hresult(in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    check_hresult(in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32));
    check_hresult(in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
    check_hresult(in->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(-static_cast<INT32>(width * 4))));
    check_hresult(MFSetAttributeSize(in.get(), MF_MT_FRAME_SIZE, width, height));
    check_hresult(MFSetAttributeRatio(in.get(), MF_MT_FRAME_RATE, fps, 1));
    check_hresult(MFSetAttributeRatio(in.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));
    check_hresult(writer_->SetInputMediaType(stream_, in.get(), nullptr));
    check_hresult(writer_->BeginWriting());
  }

  com_ptr<IMFMediaBuffer> copy_frame(const BYTE* source, UINT32 pitch) {
    const DWORD row = width_ * 4;
    const DWORD size = row * height_;
    com_ptr<IMFMediaBuffer> buffer;
    check_hresult(MFCreateMemoryBuffer(size, buffer.put()));
    BYTE* target = nullptr;
    check_hresult(buffer->Lock(&target, nullptr, nullptr));
    const BYTE* last_row = source + static_cast<size_t>(pitch) * (height_ - 1);
    const HRESULT copied = MFCopyImage(target, static_cast<LONG>(row), last_row, -static_cast<LONG>(pitch), row, height_);
    buffer->Unlock();
    check_hresult(copied);
    check_hresult(buffer->SetCurrentLength(size));
    return buffer;
  }

  void push(const com_ptr<IMFMediaBuffer>& buffer, int64_t slot) {
    com_ptr<IMFSample> sample;
    check_hresult(MFCreateSample(sample.put()));
    check_hresult(sample->AddBuffer(buffer.get()));
    const LONGLONG at = slot * 10000000 / fps_;
    check_hresult(sample->SetSampleTime(at));
    check_hresult(sample->SetSampleDuration((slot + 1) * 10000000 / fps_ - at));
    const HRESULT written = writer_->WriteSample(stream_, sample.get());
    write_failed_ = FAILED(written);
    check_hresult(written);
  }

  bool write_failed() const {
    return write_failed_;
  }

  void finish() {
    check_hresult(writer_->Finalize());
    writer_ = nullptr;
  }

 private:
  com_ptr<IMFSinkWriter> writer_;
  DWORD stream_ = 0;
  UINT32 width_ = 0;
  UINT32 height_ = 0;
  UINT32 fps_ = 60;
  bool write_failed_ = false;
};

static const int64_t CLOCK_JUMP_TICKS = 10 * 10000000; // 10 s in 100 ns ticks

static std::atomic<bool> g_stop{false};
static std::atomic<bool> g_interrupted{false};

struct SessionFeatures {
  bool cursor_hidden = false;
  bool border_hidden = false;
};

// Both are optional, and either can be missing or refused on older builds. A recording that shows them is
// better than no recording, so a no here only reaches the user as a warning
static SessionFeatures configure_session(const wgc::GraphicsCaptureSession& session) {
  SessionFeatures features;
  if (wfm::ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsCursorCaptureEnabled")) {
    try {
      session.IsCursorCaptureEnabled(false);
      features.cursor_hidden = true;
    } catch (const winrt::hresult_error&) {
    }
  }
  if (wfm::ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
    try {
      wgc::GraphicsCaptureAccess::RequestAccessAsync(wgc::GraphicsCaptureAccessKind::Borderless).get();
      session.IsBorderRequired(false);
      features.border_hidden = true;
    } catch (const winrt::hresult_error&) {
    }
  }
  return features;
}

static void read_stdin() {
  std::string line;
  while (std::getline(std::cin, line)) {
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line == "stop") {
      g_stop = true;
    } else if (line == "ping") {
      emit_line("{\"type\":\"pong\",\"hostMs\":" + host_ms(host_now_100ns()) + "}");
    }
  }
  g_stop = true;
}

static int record(const std::wstring& display, const std::wstring& output, int fps) {
  if (!wgc::GraphicsCaptureSession::IsSupported()) fail("Windows Graphics Capture isn't available on this PC");

  HMONITOR monitor = pick_monitor(display);
  auto item = item_for_monitor(monitor);
  const auto item_size = item.Size();
  const FrameSize native{static_cast<UINT32>(item_size.Width), static_cast<UINT32>(item_size.Height)};
  const FrameSize size = encode_size(native.width, native.height);
  const UINT32 width = size.width;
  const UINT32 height = size.height;
  if (width == 0 || height == 0) fail("The monitor has no size", "display");
  const bool scaled = width != (native.width & ~1u) || height != (native.height & ~1u);

  com_ptr<ID3D11DeviceContext> context;
  com_ptr<ID3D11Device> device = create_d3d(context);
  auto winrt_device = wrap_device(device);

  D3D11_TEXTURE2D_DESC staging_desc{};
  staging_desc.Width = width;
  staging_desc.Height = height;
  staging_desc.MipLevels = 1;
  staging_desc.ArraySize = 1;
  staging_desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  staging_desc.SampleDesc.Count = 1;
  staging_desc.Usage = D3D11_USAGE_STAGING;
  staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  com_ptr<ID3D11Texture2D> staging;
  check_hresult(device->CreateTexture2D(&staging_desc, nullptr, staging.put()));

  Scaler scaler;
  if (scaled) {
    try {
      scaler.open(device, native, size);
    } catch (const winrt::hresult_error& error) {
      fail("This display is too large to record: " + utf8(std::wstring(error.message())), "encoder");
    }
  }

  DeleteFileW(output.c_str());
  Mp4Writer writer;
  try {
    writer.open(output, width, height, static_cast<UINT32>(fps));
  } catch (const winrt::hresult_error& error) {
    fail("Couldn't start the H.264 writer: " + utf8(std::wstring(error.message())), "encoder");
  }

  auto pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
      winrt_device, wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item_size);
  auto session = pool.CreateCaptureSession(item);
  const SessionFeatures features = configure_session(session);
  auto closed = item.Closed(winrt::auto_revoke, [](auto&&, auto&&) {
    g_interrupted = true;
    g_stop = true;
  });

  const double scale_factor = monitor_scale(monitor) * (scaled ? static_cast<double>(width) / native.width : 1.0);
  char ready[320];
  snprintf(ready, sizeof(ready),
           "{\"type\":\"ready\",\"width\":%u,\"height\":%u,\"fps\":%d,\"scaleFactor\":%.4f,\"hostMs\":%s,"
           "\"cursorHidden\":%s,\"borderHidden\":%s}",
           width, height, fps, scale_factor, host_ms(host_now_100ns()).c_str(), features.cursor_hidden ? "true" : "false",
           features.border_hidden ? "true" : "false");
  emit_line(ready);

  std::thread(read_stdin).detach();
  session.StartCapture();

  int64_t first_ticks = -1;
  int64_t next_slot = 0;
  int64_t frames = 0;
  int64_t repeats = 0;
  com_ptr<IMFMediaBuffer> last;
  bool resolution_changed = false;
  const int64_t fill_cap = fps; // One second of repeats per pass, so stop and a clock jump are both noticed
  int64_t pass_at = host_now_100ns();
  int64_t awake_at = awake_now_100ns();

  const auto slot_of = [&](int64_t ticks) {
    return ((ticks - first_ticks) * fps + 5000000) / 10000000;
  };
  const auto fill_to = [&](int64_t slot, bool until_stop) {
    while (last && next_slot < slot && !(until_stop && g_stop.load())) {
      writer.push(last, next_slot);
      next_slot += 1;
      repeats += 1;
    }
  };

  // Anything thrown in here is a capture or write failure mid-recording. What's already encoded is worth
  // keeping, so it ends the loop and the file still gets finalized
  try {
    while (!g_stop.load()) {
      // QPC keeps counting through sleep, and filling that gap would mean hours of repeats, so the recording ends
      // where the PC went to sleep. A stall with the PC awake advances both clocks and isn't a reason to stop
      const int64_t now = host_now_100ns();
      const int64_t awake = awake_now_100ns();
      if ((now - pass_at) - (awake - awake_at) > CLOCK_JUMP_TICKS) {
        g_interrupted = true;
        break;
      }
      pass_at = now;
      awake_at = awake;

      auto frame = pool.TryGetNextFrame();
      if (!frame) {
        // Capture sends nothing while the screen is still. Repeat the last frame so the file stays a true 60 fps
        if (first_ticks >= 0) fill_to(std::min(slot_of(now) - 3, next_slot + fill_cap), true);
        Sleep(1);
        continue;
      }

      // The display changed resolution. The file, the staging texture, the Scaler and main's cursor map are all
      // sized for the old one, so what's recorded so far is kept and the recording ends here
      const auto content = frame.ContentSize();
      if (content.Width > 0 && content.Height > 0 && (content.Width != item_size.Width || content.Height != item_size.Height)) {
        frame.Close();
        resolution_changed = true;
        g_interrupted = true;
        break;
      }

      const int64_t ticks = frame.SystemRelativeTime().count();
      com_ptr<ID3D11Texture2D> texture = frame_texture(frame);
      D3D11_TEXTURE2D_DESC source{};
      texture->GetDesc(&source);
      const UINT32 copy_width = scaled ? native.width : width;
      const UINT32 copy_height = scaled ? native.height : height;
      D3D11_BOX box{0, 0, 0, std::min(copy_width, source.Width), std::min(copy_height, source.Height), 1};
      if (scaled) {
        scaler.run(context, texture.get(), box, staging.get());
      } else {
        context->CopySubresourceRegion(staging.get(), 0, 0, 0, 0, texture.get(), 0, &box);
      }

      // Map waits for the copy, and the frame has to stay open until the copy is done
      D3D11_MAPPED_SUBRESOURCE mapped{};
      check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
      com_ptr<IMFMediaBuffer> buffer = writer.copy_frame(static_cast<const BYTE*>(mapped.pData), mapped.RowPitch);
      context->Unmap(staging.get(), 0);
      frame.Close();

      if (first_ticks < 0) {
        first_ticks = ticks;
        emit_line("{\"type\":\"firstFrame\",\"hostMs\":" + host_ms(ticks) + "}");
      }
      const int64_t slot = slot_of(ticks);
      if (slot >= next_slot) {
        fill_to(std::min(slot, next_slot + fill_cap), true);
        writer.push(buffer, next_slot);
        next_slot += 1;
        frames += 1;
      }
      last = buffer;
    }
  } catch (const winrt::hresult_error& error) {
    fwprintf(stderr, L"capture stopped: %ls\n", error.message().c_str());
    g_interrupted = true;
  }

  try {
    closed.revoke();
    session.Close();
    pool.Close();
  } catch (const winrt::hresult_error&) {
    // A lost device can refuse this too, and the file still needs finishing
  }

  if (first_ticks < 0) {
    try {
      writer.finish();
    } catch (const winrt::hresult_error&) {
    }
    DeleteFileW(output.c_str());
    fail("Stopped before any frame arrived", "no-frames");
  }

  // pass_at is the last moment the loop was running, which is before the gap if the PC slept. The cap stops an
  // encoder that fell behind from holding up the stop for longer than main waits
  if (!writer.write_failed()) {
    try {
      fill_to(std::min(slot_of(pass_at) + 1, next_slot + fill_cap * 2), false);
    } catch (const winrt::hresult_error&) {
    }
  }
  const bool write_failed = writer.write_failed();
  try {
    writer.finish();
  } catch (const winrt::hresult_error& error) {
    // After a failed write this is expected, as there's no room left for the index. The file won't open, and main
    // finds that out for itself and says so. Fragmented MP4 would save it, see SPEC section 14
    if (!write_failed) fail("Couldn't finish the file: " + utf8(std::wstring(error.message())), "file");
  }

  const double duration = static_cast<double>(next_slot) * 1000.0 / fps;
  char stopped[256];
  snprintf(stopped, sizeof(stopped),
           "{\"type\":\"stopped\",\"reason\":\"%s\",\"durationMs\":%.3f,\"frames\":%lld,\"repeats\":%lld,\"dropped\":0,"
           "\"resolutionChanged\":%s}",
           write_failed ? "write-failed" : g_interrupted.load() ? "interrupted" : "requested", duration,
           static_cast<long long>(frames), static_cast<long long>(repeats), resolution_changed ? "true" : "false");
  emit_line(stopped);
  return 0;
}

static std::wstring arg_after(int argc, wchar_t** argv, const wchar_t* flag) {
  for (int i = 2; i + 1 < argc; i++) {
    if (wcscmp(argv[i], flag) == 0) return argv[i + 1];
  }
  return {};
}

int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  const std::wstring mode = argc > 1 ? argv[1] : L"";

  // Windows needs no screen capture permission
  if (mode == L"permission" || mode == L"request-permission") {
    emit_line("{\"type\":\"permission\",\"screen\":true}");
    return 0;
  }
  if (mode != L"record") fail("usage: dolly-capture record --display <x,y|primary> --output <path> [--fps 60]", "usage");

  const std::wstring output = arg_after(argc, argv, L"--output");
  if (output.empty()) fail("--output is required", "usage");
  const std::wstring fps_text = arg_after(argc, argv, L"--fps");
  const int fps = fps_text.empty() ? 60 : _wtoi(fps_text.c_str());
  if (fps < 1 || fps > 120) fail("--fps out of range", "usage");

  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  timeBeginPeriod(1);

  int code = 1;
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    check_hresult(MFStartup(MF_VERSION));
    code = record(arg_after(argc, argv, L"--display"), output, fps);
    MFShutdown();
  } catch (const winrt::hresult_error& error) {
    fail("Capture failed: " + utf8(std::wstring(error.message())));
  } catch (const std::exception& error) {
    fail(std::string("Capture failed: ") + error.what());
  }
  timeEndPeriod(1);
  quit(code);
}
