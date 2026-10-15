#!/usr/bin/env bash
set -u

# DELL runs Ollama as a Windows process so its existing models and GPU setup are
# reused. The WSL user service cannot call Windows localhost directly, but a
# Windows executable launched by WSL can. Keep the listener on Windows
# localhost; do not expose Ollama to the LAN just to make the worker reach it.

ollama_exe="${FEDDIT_OLLAMA_EXE:-/mnt/c/dev/inference-runtime/ollama-0.34.1/ollama.exe}"
expected_sha="1ff56c8b2c791bff69b6457d25aa63ed11073562cd47b14f42dd16dfa4353e05"
curl_exe="/mnt/c/Windows/System32/curl.exe"
health_url="http://127.0.0.1:11434/api/version"

# Never execute the desktop application's mutable, auto-updated binary. This
# operational pin preserves the rendering/tokenizer contract; it is not an
# exemption from the worker's model and request verification.
actual_sha=$(sha256sum "$ollama_exe" 2>/dev/null | cut -d ' ' -f 1)
if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo 'Verified Ollama executable missing or hash mismatch; no runtime started.' >&2
    exit 78
fi

while true; do
    if version_json=$("$curl_exe" -fsS --max-time 3 "$health_url" 2>/dev/null); then
        if ! printf '%s' "$version_json" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("version") == "0.34.1" else 1)'; then
            echo 'Another unverified Ollama runtime owns localhost; refusing to replace or accept it.' >&2
            exit 78
        fi
        sleep 10
        continue
    fi

    # This blocks while the server is healthy. If it exits, retry after a short
    # delay. If the desktop Ollama app starts first, the health check above
    # notices it and avoids launching a duplicate listener.
    "$ollama_exe" serve || true
    sleep 5
done
