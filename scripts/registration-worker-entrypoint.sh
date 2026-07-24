#!/usr/bin/env bash
set -euo pipefail

solver_pid=""
registration_pid=""

cleanup() {
  if [[ -n "${registration_pid}" ]]; then
    kill "${registration_pid}" 2>/dev/null || true
  fi
  if [[ -n "${solver_pid}" ]]; then
    kill "${solver_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

mkdir -p /app/turnstile-solver/logs /app/turnstile-solver/keys

python /app/turnstile-solver/api_solver.py \
  --browser_type "${TURNSTILE_BROWSER_TYPE:-camoufox}" \
  --thread "${TURNSTILE_THREAD:-1}" \
  --host "${TURNSTILE_HOST:-127.0.0.1}" \
  --port "${TURNSTILE_PORT:-5072}" \
  --debug \
  > /app/turnstile-solver/logs/turnstile_solver.log 2>&1 &
solver_pid=$!

python -B /app/scripts/registration_service.py &
registration_pid=$!
wait "${registration_pid}"
