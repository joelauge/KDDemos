# Foveal Latent Explorer

A latent-space visualizer for modern browsers. It borrows two ideas from VR headsets:

- **Foveated rendering.** Pixels near the gaze are shaded at full rate and the periphery at coarse rates.
- **Foveated streaming.** Only the data under the gaze is sent at full fidelity.

All of the heavy work runs in WebAssembly.

Open `index.html` directly, or at `https://demos.knowdrive.ai/latent-fovea/` once it's on `main`. The page is one static file with no build step at deploy time. The wasm is embedded as base64.

## How the headset idea maps onto a latent space

| Headset | Latent-space explorer |
|---|---|
| Eye tracker gives a gaze point | Cursor, touch, or a saccade autopilot (70 ms jumps, ~1 s fixations). Anything that produces `(x, y)` can drive it. |
| **Fovea** (about 2.5° radius), full shading | Full **D-dimensional vectors** are read for the points here. PCA is recomputed on just these points each frame (a local lens, the LatentGandr / local-embedding idea). True kNN runs in full-D space, and the focused point and its neighbours are **decoded** to images. |
| **Parafovea**, reduced detail | Only cached 2D positions are used. Points are drawn from a *stratified prefix sample* per grid cell, and the kept fraction falls off with eccentricity. |
| **Periphery**, low res | Per-point data is never touched. Shading samples a **density mip-pyramid** (256² down to 16²) at variable rates of 1×1, 2×2, 4×4 and 8×8 pixels by eccentricity, which is the web equivalent of VRS. |
| **Foveated streaming**: the headset sends high bitrate only where you look | The 2D projection is cut into a 256×256 grid. Vectors are stored **cell-major**, so each cell is one contiguous byte range: a *tile*. Tiles under the fovea are fetched nearest-gaze-first under a bandwidth budget and kept in an LRU (clock) cache. Tiles not yet resident show as low-detail points until they arrive. |
| Compositor | The wasm kernel rasterizes straight into a framebuffer in linear memory. JS does one `putImageData` per frame and draws a thin overlay. |

The result is that per-frame cost scales with **what you look at**, not with N. At 200k × 64-D the kernel touches about 35–80k of 200k points and reads full vectors for at most 8,192. That gives about 60 fps at 1440×900 in headless Chromium. Turn foveation off with `F` to see the naive baseline: every point every frame, all 51 MB resident up front, about 3× the frame cost.

## Where WebAssembly helps

Measured in headless Chromium on the dev container (200k × 64-D, brute-force kNN, k = 8):

| Engine | Time | Scan rate |
|---|---|---|
| WebAssembly + SIMD | ~6 ms | ~8.5 GB/s |
| Plain JS (typed arrays) | ~31 ms | ~1.7 GB/s |

Use the "Benchmark both" button to reproduce this on your own machine.

What wasm buys you here:

1. **One linear memory for everything.** Vectors, grid index, density pyramid and framebuffer all live together. The data never goes through JS objects, and there's no GC pressure at 50–150 MB.
2. **SIMD** (`-msimd128`) for the dot-product-heavy kernels: kNN scan, local PCA, and the decoder. A baseline build is embedded as a fallback and chosen by `WebAssembly.validate`.
3. **Predictable frame time.** No JIT tiering or deopts in the hot loop.
4. **Portability of the kernel.** The same C runs natively. It could also sit server-side to answer the kNN queries that need the full index.

## Files

- `src/fovea.c`: the kernel. It has no libc and no imports, and exports `init`, `render`, `knn`, `decode`, `fb_alloc`, `set_cache` and `flush_cache`.
- `build.sh`: builds SIMD and baseline wasm with `clang --target=wasm32` and embeds both into `index.html`.
- `index.html`: UI, input, overlay, the JS kNN reference, and stats.

Rebuild after editing the C: `./build.sh` (needs clang with the wasm32 target plus `wasm-ld`, and python3).

## The data

The data is synthetic so the page is self-contained. There are 24 clusters in 6 families. Each cluster is a curved 2D sheet embedded in D dims. Family separation dominates global variance, so the **global** PCA collapses each family into one blob. Look at a family with the lens on and the **local** PCA pulls its four clusters apart, which is the reason to run local re-projection in the fovea. The kNN lines show the same thing from the other side: true 64-D neighbours can sit away from the focus point in the 2D projection.

## Going to production

- **Real embeddings.** Precompute the global projection (UMAP/PCA) offline. Write vectors cell-major into one file per zoom level, or into a Zarr/Parquet layout. Serve tiles with HTTP range requests, so the streaming queue here turns into real `fetch`es. Ship the density pyramid up front (a few hundred KB).
- **Generative models.** Swap `decode()` for the real decoder (VAE/diffusion via ONNX Runtime Web or WebGPU) and call it only for the fovea. That's where foveation pays off most, because decoding is far more expensive than drawing.
- **Threads.** Move the kernel into a Worker with `OffscreenCanvas`. Shared-memory threads (`SharedArrayBuffer`) need COOP/COEP headers. GitHub Pages can't set those, so use a host that can or the `coi-serviceworker` shim.
- **WebGPU.** The periphery pass and splatting map directly to a compute shader plus a point pipeline. Keep wasm for the irregular, branchy work: tile scheduling, kNN, local PCA.
- **Real gaze.** WebXR headsets expose gaze only in limited forms (for example transient-pointer input on visionOS). Webcam trackers such as WebGazer.js give coarse gaze on desktop. The kernel takes any `(x, y)`, so pair a noisy tracker with a larger fovea radius.
- **Prefetch.** Extrapolate gaze velocity during saccades and enqueue tiles along the path. Real headsets hide latency this way.
