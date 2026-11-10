# KnowBot API container: llama.cpp llama-server (Qwen2.5-1.5B-Instruct Q4_K_M) + the KnowBot Node server, plus the
# optional evidence selector (attendd, loopback only).
# Build context is the knowbot/ root (see wrangler.jsonc image_build_context).

# attendd: built only when the engine source was fetched into .engine-src (scripts/fetch-engine.sh; git-ignored, never
# committed). Without it this stage leaves an empty /out and the image runs without attendd (the old evidence path).
# "COPY attendd/ENGINE_SHA .engine-sr[c]" tolerates a missing .engine-src (a glob that matches nothing is skipped).
FROM golang:1.26-bookworm AS attendd
ENV GOTOOLCHAIN=auto CGO_ENABLED=0
WORKDIR /src
COPY attendd/ENGINE_SHA .engine-sr[c] /src/.engine-src/
COPY attendd /src/attendd
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then cp /run/secrets/ca /usr/local/share/ca-certificates/build-ca.crt && update-ca-certificates >/dev/null; fi \
 && mkdir -p /out \
 && if [ -f /src/.engine-src/go.mod ]; then cd /src/attendd && go build -trimpath -ldflags='-s -w' -o /out/attendd . && echo "attendd built"; \
    else echo "no engine source: image without attendd"; fi

FROM node:22-bookworm-slim

ARG LLAMA_TAG=b11450
ARG LLAMA_SHA256=a9a5c229a56ff61be66ad5ae0ddb2051201dbc091ccda1062553fbdf1152adc1
ARG MODEL_URL=https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Optional build secret "ca" (an extra CA bundle) for building behind a TLS-inspecting proxy; unused on Cloudflare.
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export CURL_CA_BUNDLE=/run/secrets/ca; fi \
 && mkdir -p /opt/llama /opt/models \
 && curl -fsSL -o /tmp/llama.tgz "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz" \
 && echo "${LLAMA_SHA256}  /tmp/llama.tgz" | sha256sum -c - \
 && tar -xzf /tmp/llama.tgz -C /opt/llama --strip-components=1 \
 && rm /tmp/llama.tgz \
 && curl -fsSL -o /opt/models/model.gguf "${MODEL_URL}"

WORKDIR /app
# The Anthropic SDK (for bots that answer with Claude) is the server's only npm dependency.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY lib ./lib
COPY server ./server
COPY corpus ./corpus
# KnowBot Studio: the Lumen Bikes sample files the 'Use sample files' demo ingests
COPY studio/samples ./studio/samples
# KnowBot Studio Builder: the bundled KnowBot knowledge base (server/builder/local-kb.mjs + kb.mjs read studio/kb/*.md)
COPY studio/kb ./studio/kb
# The evidence selector (absent when the build had no engine source; entrypoint.sh then skips it)
COPY --from=attendd /out/ /opt/attendd/
COPY cloudflare/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=8787 HOST=0.0.0.0 \
    LLM_BASE_URL=http://127.0.0.1:8080/v1 LLM_MODEL=qwen2.5-1.5b-instruct \
    KNOWBOT_ANSWER_MODE=select KNOWBOT_TRUST_PROXY=1 KNOWBOT_DATA_DIR=/tmp/knowbot-data
EXPOSE 8787
ENTRYPOINT ["/entrypoint.sh"]
