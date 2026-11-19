#!/bin/sh
set -eu
# Flutter writes SDK locks/stamps even after precaching. Keep its writable copy
# project-private; the container root remains read-only and /tmp remains noexec.
state=/workspace/.flutterforge/worker
mkdir -p "$state"
if [ ! -f "$state/sdk-ready" ]; then
  mkdir -p "$state/flutter"
  cp -Rf /opt/flutter/. "$state/flutter/"
  touch "$state/sdk-ready"
fi
export HOME="$state/home"
export PUB_CACHE="$state/pub-cache"
export FLUTTER_ROOT="$state/flutter"
export PATH="$FLUTTER_ROOT/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export TMPDIR=/tmp
export CI=true
mkdir -p "$HOME" "$PUB_CACHE"
# Repair caches initialized by the older shallow checkout without its release tag.
if ! git -C "$FLUTTER_ROOT" describe --tags --exact-match HEAD >/dev/null 2>&1; then
  release=$(git -C /opt/flutter describe --tags --exact-match HEAD)
  if [ "$(git -C /opt/flutter rev-parse HEAD)" = "$(git -C "$FLUTTER_ROOT" rev-parse HEAD)" ]; then
    git -C "$FLUTTER_ROOT" tag "$release"
    rm -f "$FLUTTER_ROOT/bin/cache/flutter.version.json"
  fi
fi
exec "$@"
