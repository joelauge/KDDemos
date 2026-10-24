#!/usr/bin/env bash
# Start llama-server for KnowBot (OpenAI-compatible API at http://127.0.0.1:8080/v1).
# Detaches (setsid + nohup) so the server survives the calling shell; idempotent:
# if something already answers /health on the port, it does nothing.
#
# Env overrides:
#   KNOWBOT_HOME, KNOWBOT_MODELS_DIR   (same as setup-model.sh)
#   KNOWBOT_MODEL_FILE   full path to a .gguf (default: 1.5B Q4_K_M in models dir)
#   KNOWBOT_MODEL_ALIAS  default qwen2.5-1.5b-instruct
#   KNOWBOT_PORT         default 8080      KNOWBOT_CTX  default 8192
#   KNOWBOT_LOG          default $KNOWBOT_HOME/llama.log
#   KNOWBOT_FOREGROUND=1 run in the foreground (e.g. under a process manager)
# Stop: scripts/start-model.sh stop
set -euo pipefail

KNOWBOT_HOME="${KNOWBOT_HOME:-$HOME/.cache/knowbot}"
MODELS_DIR="${KNOWBOT_MODELS_DIR:-$KNOWBOT_HOME/models}"
MODEL_FILE="${KNOWBOT_MODEL_FILE:-$MODELS_DIR/qwen2.5-1.5b-instruct-q4_k_m.gguf}"
ALIAS="${KNOWBOT_MODEL_ALIAS:-qwen2.5-1.5b-instruct}"
HOST=127.0.0.1
PORT="${KNOWBOT_PORT:-8080}"
CTX="${KNOWBOT_CTX:-8192}"
BIN="$KNOWBOT_HOME/llama.cpp/current/llama-server"
LOG="${KNOWBOT_LOG:-$KNOWBOT_HOME/llama.log}"
PIDFILE="$KNOWBOT_HOME/llama-server.$PORT.pid"

log() { printf '[start-model] %s\n' "$*" >&2; }
healthy() { curl -fsS --max-time 2 "http://$HOST:$PORT/health" >/dev/null 2>&1; }

if [ "${1:-}" = "stop" ]; then
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")"; log "stopped pid $(cat "$PIDFILE")"; rm -f "$PIDFILE"
  else
    log "no running server recorded in $PIDFILE"
  fi
  exit 0
fi

[ -x "$BIN" ] || { log "llama-server not found at $BIN — run scripts/setup-model.sh"; exit 1; }
[ -f "$MODEL_FILE" ] || { log "model not found: $MODEL_FILE — run scripts/setup-model.sh"; exit 1; }

if healthy; then
  log "server already healthy on $HOST:$PORT (pid $(cat "$PIDFILE" 2>/dev/null || echo '?'))"
  exit 0
fi

# --kv-unified: the 2 slots share one 8192-token KV pool (without it, explicit
# -np 2 splits the context into 2 x 4096).
ARGS=(
  -m "$MODEL_FILE"
  --host "$HOST" --port "$PORT"
  --alias "$ALIAS"
  -c "$CTX"
  -t "$(nproc)"
  -np 2 --kv-unified
  --jinja
  --no-webui
  --metrics
)

mkdir -p "$(dirname "$LOG")"
if [ "${KNOWBOT_FOREGROUND:-0}" = "1" ]; then
  exec "$BIN" "${ARGS[@]}" >>"$LOG" 2>&1
fi

log "starting $BIN (log: $LOG)"
setsid nohup "$BIN" "${ARGS[@]}" >>"$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"

for _ in $(seq 1 120); do
  if healthy; then log "ready: http://$HOST:$PORT/v1 (model alias: $ALIAS, pid $(cat "$PIDFILE"))"; exit 0; fi
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { log "server exited; tail of $LOG:"; tail -n 30 "$LOG" >&2; exit 1; }
  sleep 1
done
log "server did not become healthy within 120s; see $LOG"; exit 1
