#!/bin/sh
# Mirror the file-backed Xray logs to supervisord/PID 1 stdout.
#
# Xray stays file-backed so the admin API can read it with supervisorctl tail.
# The bridge restores the second observability surface: Amvera's application
# log stream. It writes directly to PID 1's stdout rather than this program's
# stdout, avoiding a feedback loop through supervisord's own log capture.
set -eu

LOG_DIR="/var/log/supervisor"
exec 3>/proc/1/fd/1

forward_log() {
  file="$1"
  label="$2"
  tail -n 0 -F "$file" 2>/dev/null |
    while IFS= read -r line; do
      printf '[%s] %s\n' "$label" "$line" >&3
    done
}

forward_log "$LOG_DIR/xray.log" "xray" &
stdout_forwarder=$!
forward_log "$LOG_DIR/xray-error.log" "xray-error" &
stderr_forwarder=$!

cleanup() {
  kill "$stdout_forwarder" "$stderr_forwarder" 2>/dev/null || true
  wait "$stdout_forwarder" "$stderr_forwarder" 2>/dev/null || true
}

trap cleanup INT TERM EXIT
while kill -0 "$stdout_forwarder" 2>/dev/null && kill -0 "$stderr_forwarder" 2>/dev/null; do
  sleep 1
done