#!/usr/bin/env bash
set -u

# DELL runs Ollama as a Windows process so its existing models and GPU setup are
# reused. The WSL user service cannot call Windows localhost directly, but a
# Windows executable launched by WSL can. Keep the listener on Windows
# localhost; do not expose Ollama to the LAN just to make the worker reach it.

ollama_exe="/mnt/c/Users/User/AppData/Local/Programs/Ollama/ollama.exe"
curl_exe="/mnt/c/Windows/System32/curl.exe"
health_url="http://127.0.0.1:11434/api/tags"

while true; do
    if "$curl_exe" -fsS --max-time 3 "$health_url" >/dev/null 2>&1; then
        sleep 10
        continue
    fi

    # This blocks while the server is healthy. If it exits, retry after a short
    # delay. If the desktop Ollama app starts first, the health check above
    # notices it and avoids launching a duplicate listener.
    "$ollama_exe" serve || true
    sleep 5
done
