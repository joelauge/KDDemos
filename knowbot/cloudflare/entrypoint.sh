#!/bin/sh
# Start llama-server, wait until the model is loaded, then run the KnowBot server in the foreground.
set -e
LD_LIBRARY_PATH=/opt/llama:${LD_LIBRARY_PATH} /opt/llama/llama-server \
  -m /opt/models/model.gguf --alias qwen2.5-1.5b-instruct \
  --host 127.0.0.1 --port 8080 -c "${KNOWBOT_CTX:-8192}" -t "$(nproc)" -np 2 --kv-unified --jinja --no-webui >/tmp/llama.log 2>&1 &
LLAMA=$!
i=0
until curl -fsS --max-time 2 http://127.0.0.1:8080/health >/dev/null 2>&1; do
  kill -0 "$LLAMA" 2>/dev/null || { cat /tmp/llama.log; exit 1; }
  i=$((i + 1)); [ "$i" -gt 120 ] && { echo "llama-server did not become healthy"; cat /tmp/llama.log; exit 1; }
  sleep 1
done
exec node /app/server/server.mjs
