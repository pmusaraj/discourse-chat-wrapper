#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# This app needs two backend-only native operations absent from TinyJS 0.42.3.
# Keep the patch reproducible rather than relying on a locally modified binary.
chat_runtime_dir=.runtime/chat-patch/source
chat_runtime_hash=$(cat native/chat-session.inc scripts/patch-runtime.py scripts/build-runtime.sh | shasum -a 256 | cut -d ' ' -f 1)
if [ -f .runtime/chat-patch/hash ] && [ "$(cat .runtime/chat-patch/hash)" = "$chat_runtime_hash" ] && rg -q 'chatSession\(origin' .runtime/runtime/bridge.js; then
  exit 0
fi
if [ ! -f "$chat_runtime_dir/native/launcher-macos.cc.original" ]; then
  mkdir -p "$chat_runtime_dir"
  curl -fL --retry 3 https://codeload.github.com/tarwin/tinyjsapp/tar.gz/refs/tags/v0.42.3 -o .runtime/chat-patch/source.tar.gz
  echo 'f64b019f2cadc30707b6fd1f8ee0cd8afad9d31b3d1302ea0593e2d54b87550a  .runtime/chat-patch/source.tar.gz' | shasum -a 256 -c -
  tar -xzf .runtime/chat-patch/source.tar.gz -C "$chat_runtime_dir" --strip-components=1
  cp "$chat_runtime_dir/native/launcher-macos.cc" "$chat_runtime_dir/native/launcher-macos.cc.original"
fi
cp "$chat_runtime_dir/native/launcher-macos.cc.original" "$chat_runtime_dir/native/launcher-macos.cc"
cp native/chat-session.inc "$chat_runtime_dir/native/chat-session.inc"
python3 scripts/patch-runtime.py "$chat_runtime_dir/native/launcher-macos.cc"
mkdir -p "$chat_runtime_dir/runtime"
cp .runtime/runtime/tiny.js "$chat_runtime_dir/runtime/tiny.js"
sh "$chat_runtime_dir/native/gen-client.sh"
c++ -std=c++17 -x objective-c++ -mmacosx-version-min=14.0 -arch "$(uname -m)" \
  -isystem "$chat_runtime_dir/native/include" "$chat_runtime_dir/native/launcher-macos.cc" \
  -o .runtime/chat-patch/launcher \
  -framework WebKit -framework AppKit -framework Carbon -framework UserNotifications \
  -framework AVFoundation -framework ServiceManagement -framework IOKit -framework Quartz \
  -framework Vision -framework QuickLookThumbnailing -framework Security \
  -framework LocalAuthentication -framework MediaPlayer -framework CoreMedia \
  -framework CoreWLAN -framework CoreAudio -framework AudioToolbox -framework UniformTypeIdentifiers \
  -weak_framework ScreenCaptureKit -ldl
cp .runtime/chat-patch/launcher .runtime/native/launcher-macos
codesign --force --sign - .runtime/native/launcher-macos
printf '%s\n' "$chat_runtime_hash" > .runtime/chat-patch/hash
