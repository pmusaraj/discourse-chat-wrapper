#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if [ "$(uname -s)" != Darwin ]; then
  echo "This proof of concept currently targets macOS only." >&2
  exit 1
fi

if [ -x .runtime/tinyjs ]; then
  sh scripts/build-runtime.sh
  exec ./.runtime/tinyjs version
fi

version=v0.42.3
arch=$(uname -m)
case "$arch" in
  arm64|x86_64) ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac
asset="tinyjs-macos-$arch.tar.gz"
base="https://github.com/tarwin/tinyjsapp/releases/download/$version"
download_dir=$(mktemp -d)
trap 'rm -rf "$download_dir"' EXIT
curl -fL --retry 3 "$base/$asset" -o "$download_dir/$asset"
curl -fL --retry 3 "$base/checksums.txt" -o "$download_dir/checksums.txt"
(
  cd "$download_dir"
  awk -v name="$asset" '$2 == name {print}' checksums.txt > selected-checksum.txt
  test -s selected-checksum.txt
  shasum -a 256 -c selected-checksum.txt
)
mkdir -p .runtime
tar -xzf "$download_dir/$asset" -C .runtime --strip-components 1
./.runtime/tinyjs version

sh scripts/build-runtime.sh
