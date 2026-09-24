#!/usr/bin/env bash
# Compile the WebAssembly kernel (SIMD + baseline builds) and embed both into
# index.html so the page stays a single static file with no fetches.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/latent-fovea-build"
mkdir -p "$OUT"
FLAGS=(--target=wasm32 -nostdlib -O3 -ffast-math -fno-builtin -mbulk-memory
       -Wl,--no-entry -Wl,--export-dynamic -Wl,--strip-all -Wl,-z,stack-size=1048576
       -fvisibility=hidden)
clang "${FLAGS[@]}" -msimd128 -o "$OUT/fovea.simd.wasm" src/fovea.c
clang "${FLAGS[@]}"           -o "$OUT/fovea.wasm"      src/fovea.c
python3 - "$OUT" <<'PY'
import base64, re, sys, pathlib
out = pathlib.Path(sys.argv[1])
page = pathlib.Path("index.html")
html = page.read_text()
for name, var in (("fovea.simd.wasm", "WASM_SIMD"), ("fovea.wasm", "WASM_BASE")):
    b64 = base64.b64encode((out / name).read_bytes()).decode()
    html, n = re.subn(rf'const {var} = "[^"]*";', f'const {var} = "{b64}";', html)
    assert n == 1, var
page.write_text(html)
print("embedded", {p.name: p.stat().st_size for p in out.glob("*.wasm")})
PY
