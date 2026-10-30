cmake_minimum_required(VERSION 3.20)
project(dolly-capture LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static CRT, so the helper runs without the Visual C++ redistributable
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(dolly-capture main.cpp)
target_compile_definitions(dolly-capture PRIVATE UNICODE _UNICODE)
target_compile_options(dolly-capture PRIVATE /EHsc /utf-8 /permissive- /bigobj /W3)
target_link_libraries(dolly-capture PRIVATE windowsapp d2d1 d3d11 dxgi mfplat mfreadwrite mfuuid shcore winmm user32)
