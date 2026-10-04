#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
sh scripts/build-runtime.sh
mkdir -p .e2e
# Patch only a disposable COPY. Every test window uses an ephemeral WK data store.
mkdir -p .e2e/native
cp -R .runtime/chat-patch/source/native/. .e2e/native/
python3 - <<'PY'
from pathlib import Path
p = Path('.e2e/native/include/webview/detail/backends/cocoa_webkit.hh')
s = p.read_text()
needle = 'auto config{objc::autorelease(WKWebViewConfiguration_new())};'
assert s.count(needle) == 1
s = s.replace(needle, needle + '''
    objc::msg_send<void>(config, objc::selector("setWebsiteDataStore:"),
      objc::msg_send<id>(objc::get_class("WKWebsiteDataStore"), objc::selector("nonPersistentDataStore")));
''')
p.write_text(s)
PY
c++ -std=c++17 -x objective-c++ -mmacosx-version-min=14.0 -arch "$(uname -m)" \
  -isystem .e2e/native/include .e2e/native/launcher-macos.cc -o .e2e/launcher \
  -framework WebKit -framework AppKit -framework Carbon -framework UserNotifications \
  -framework AVFoundation -framework ServiceManagement -framework IOKit -framework Quartz \
  -framework Vision -framework QuickLookThumbnailing -framework Security \
  -framework LocalAuthentication -framework MediaPlayer -framework CoreMedia \
  -framework CoreWLAN -framework CoreAudio -framework AudioToolbox -framework UniformTypeIdentifiers \
  -weak_framework ScreenCaptureKit -ldl
codesign --force --sign - .e2e/launcher
