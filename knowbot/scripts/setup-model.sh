#!/usr/bin/env bash
# KnowBot model runtime setup (idempotent).
#
# Installs a pinned llama.cpp `llama-server` (prebuilt Linux x64 CPU release,
# falling back to a cmake source build of the same tag) and downloads a Qwen2.5
# Instruct GGUF (Q4_K_M) into a models dir outside git, verifying size + sha256.
#
# Env overrides:
#   KNOWBOT_HOME        default $HOME/.cache/knowbot
#   KNOWBOT_MODELS_DIR  default $KNOWBOT_HOME/models
#   KNOWBOT_LLAMA_TAG   default b11450 (pinned; change together with LLAMA_TGZ_SHA256)
#   KNOWBOT_MODEL       0.5b | 1.5b (default) | 3b
#   KNOWBOT_FORCE_BUILD=1  skip the prebuilt download and build from source
#
# Usage: scripts/setup-model.sh            # binary + default 1.5B model
#        KNOWBOT_MODEL=3b scripts/setup-model.sh
set -euo pipefail

KNOWBOT_HOME="${KNOWBOT_HOME:-$HOME/.cache/knowbot}"
MODELS_DIR="${KNOWBOT_MODELS_DIR:-$KNOWBOT_HOME/models}"
LLAMA_TAG="${KNOWBOT_LLAMA_TAG:-b11450}"
# sha256 of llama-b11450-bin-ubuntu-x64.tar.gz (GitHub does not publish checksums;
# recorded at pin time 2026-10-24). Only enforced for the default tag.
LLAMA_TGZ_SHA256_PINNED="a9a5c229a56ff61be66ad5ae0ddb2051201dbc091ccda1062553fbdf1152adc1"
LLAMA_ROOT="$KNOWBOT_HOME/llama.cpp"
LLAMA_DIR="$LLAMA_ROOT/$LLAMA_TAG"
MODEL="${KNOWBOT_MODEL:-1.5b}"

log() { printf '[setup-model] %s\n' "$*" >&2; }
die() { printf '[setup-model] ERROR: %s\n' "$*" >&2; exit 1; }

case "$MODEL" in
  0.5b) REPO="Qwen/Qwen2.5-0.5B-Instruct-GGUF"; FILE="qwen2.5-0.5b-instruct-q4_k_m.gguf"
        SIZE=491400032;  SHA="74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db" ;;
  1.5b) REPO="Qwen/Qwen2.5-1.5B-Instruct-GGUF"; FILE="qwen2.5-1.5b-instruct-q4_k_m.gguf"
        SIZE=1117320736; SHA="6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e" ;;
  3b)   REPO="Qwen/Qwen2.5-3B-Instruct-GGUF";   FILE="qwen2.5-3b-instruct-q4_k_m.gguf"
        SIZE=2104932768; SHA="626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d" ;;
  *) die "unknown KNOWBOT_MODEL=$MODEL (use 0.5b, 1.5b or 3b)" ;;
esac

for c in curl tar sha256sum; do command -v "$c" >/dev/null || die "missing required tool: $c"; done
mkdir -p "$KNOWBOT_HOME" "$MODELS_DIR" "$LLAMA_ROOT"
if [ -t 2 ]; then CURL_PROGRESS=(--progress-bar); else CURL_PROGRESS=(-sS); fi

# ---------------------------------------------------------------- llama-server
server_ok() { [ -x "$LLAMA_DIR/llama-server" ] && "$LLAMA_DIR/llama-server" --version >/dev/null 2>&1; }

install_prebuilt() {
  local asset="llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz"
  local url="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${asset}"
  local tmp; tmp="$(mktemp -d "$LLAMA_ROOT/.dl.XXXXXX")"
  log "downloading prebuilt $asset"
  if ! curl "${CURL_PROGRESS[@]}" -fL --retry 3 --retry-delay 2 -o "$tmp/$asset" "$url"; then
    rm -rf "$tmp"; return 1
  fi
  if [ "$LLAMA_TAG" = "b11450" ]; then
    echo "$LLAMA_TGZ_SHA256_PINNED  $tmp/$asset" | sha256sum -c --quiet - \
      || { rm -rf "$tmp"; die "sha256 mismatch for $asset"; }
  fi
  tar xzf "$tmp/$asset" -C "$tmp"
  [ -x "$tmp/llama-${LLAMA_TAG}/llama-server" ] || { rm -rf "$tmp"; return 1; }
  rm -rf "$LLAMA_DIR"; mv "$tmp/llama-${LLAMA_TAG}" "$LLAMA_DIR"; rm -rf "$tmp"
  # The tarball ships its .so files next to the binaries with RUNPATH=$ORIGIN.
  server_ok
}

build_from_source() {
  command -v cmake >/dev/null && command -v git >/dev/null && command -v g++ >/dev/null \
    || die "source build needs cmake, git and g++"
  local src="$LLAMA_ROOT/src-$LLAMA_TAG"
  if [ ! -d "$src/.git" ]; then
    log "cloning llama.cpp $LLAMA_TAG"
    git clone --depth 1 --branch "$LLAMA_TAG" https://github.com/ggml-org/llama.cpp "$src"
  fi
  log "building llama-server from source (this takes a few minutes)"
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON \
        -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DBUILD_SHARED_LIBS=OFF
  cmake --build "$src/build" --target llama-server -j "$(nproc)"
  mkdir -p "$LLAMA_DIR"; cp "$src/build/bin/llama-server" "$LLAMA_DIR/"
  server_ok
}

if server_ok; then
  log "llama-server $LLAMA_TAG already installed"
else
  if [ "${KNOWBOT_FORCE_BUILD:-0}" = "1" ] || ! install_prebuilt; then
    log "prebuilt unavailable; falling back to source build"
    build_from_source || die "llama-server install failed"
  fi
fi
ln -sfn "$LLAMA_DIR" "$LLAMA_ROOT/current"
log "llama-server: $LLAMA_ROOT/current/llama-server ($("$LLAMA_DIR/llama-server" --version 2>&1 | grep -m1 version || true))"

# ---------------------------------------------------------------- model
dest="$MODELS_DIR/$FILE"
marker="$dest.sha256-ok"
filesize() { stat -c %s "$1" 2>/dev/null || echo 0; }

if [ -f "$dest" ] && [ "$(filesize "$dest")" = "$SIZE" ] && [ -f "$marker" ] && [ "$(cat "$marker")" = "$SHA" ]; then
  log "model $FILE already present and verified"
else
  if [ ! -f "$dest" ] || [ "$(filesize "$dest")" != "$SIZE" ]; then
    url="https://huggingface.co/${REPO}/resolve/main/${FILE}"
    log "downloading $FILE ($((SIZE / 1024 / 1024)) MiB) from $REPO"
    # resumable: partial file kept as .part between runs
    curl "${CURL_PROGRESS[@]}" -fL --retry 5 --retry-delay 3 -C - -o "$dest.part" "$url"
    mv -f "$dest.part" "$dest"
  fi
  got="$(filesize "$dest")"
  [ "$got" = "$SIZE" ] || { rm -f "$dest"; die "size mismatch for $FILE: got $got, want $SIZE"; }
  log "verifying sha256"
  echo "$SHA  $dest" | sha256sum -c --quiet - || { rm -f "$dest"; die "sha256 mismatch for $FILE"; }
  echo "$SHA" > "$marker"
fi
log "model: $dest ($(filesize "$dest") bytes, verified)"
echo "$dest"
