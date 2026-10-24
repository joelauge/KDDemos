# KnowBot API container: llama.cpp llama-server (Qwen2.5-1.5B-Instruct Q4_K_M) + the KnowBot Node server.
# Build context is the knowbot/ root (see wrangler.jsonc image_build_context).
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
COPY lib ./lib
COPY server ./server
COPY corpus ./corpus
COPY cloudflare/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=8787 HOST=0.0.0.0 \
    LLM_BASE_URL=http://127.0.0.1:8080/v1 LLM_MODEL=qwen2.5-1.5b-instruct \
    KNOWBOT_ANSWER_MODE=select KNOWBOT_TRUST_PROXY=1 KNOWBOT_DATA_DIR=/tmp/knowbot-data
EXPOSE 8787
ENTRYPOINT ["/entrypoint.sh"]
