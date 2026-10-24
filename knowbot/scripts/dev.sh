#!/usr/bin/env bash
# Start the local model (if needed) and the KnowBot server, then print URLs.
#   knowbot/scripts/dev.sh            # foreground server (Ctrl-C stops server; model keeps running)
#   PORT=8787 LLM_BASE_URL=... KNOWDRIVE_API_KEY=... knowbot/scripts/dev.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8787}"
LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:8080/v1}"
export PORT LLM_BASE_URL

llm_up() { curl -fsS -m 2 "${LLM_BASE_URL%/}/models" >/dev/null 2>&1; }

if llm_up; then
  echo "[dev] model already up at $LLM_BASE_URL"
elif [[ -x "$HERE/start-model.sh" || -f "$HERE/start-model.sh" ]]; then
  echo "[dev] starting model via scripts/start-model.sh ..."
  mkdir -p "$ROOT/server/data"
  nohup bash "$HERE/start-model.sh" >"$ROOT/server/data/model.log" 2>&1 &
  for i in $(seq 1 120); do llm_up && break; sleep 1; done
  if llm_up; then echo "[dev] model up at $LLM_BASE_URL"; else echo "[dev] WARNING: model not reachable yet (see server/data/model.log); continuing"; fi
else
  echo "[dev] WARNING: no model at $LLM_BASE_URL and no scripts/start-model.sh; /api/chat and /api/canonical will 502"
fi

if curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "[dev] a server is already listening on :$PORT"
else
  echo "[dev] starting KnowBot server on :$PORT"
fi

cat <<URLS

  KnowBot server   http://localhost:$PORT/
  Health           http://localhost:$PORT/healthz
  Config           http://localhost:$PORT/api/config
  Dashboard        http://localhost:$PORT/dashboard/
  Demos            http://localhost:$PORT/demo/
  Model            $LLM_BASE_URL

URLS

curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && exit 0
exec node "$ROOT/server/server.mjs"
