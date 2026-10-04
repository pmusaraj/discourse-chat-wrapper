#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build
c++ -std=c++17 -mmacosx-version-min=14.0 test/native-session.mm -framework AppKit -framework WebKit -o .build/test-native-session
.build/test-native-session
