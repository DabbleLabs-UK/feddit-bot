@echo off
set "OLLAMA_HOST=127.0.0.1:11434"
set "OLLAMA_MODELS=C:\wamp\www\open-webui\ollama-models"
set "OLLAMA_LOAD_TIMEOUT=30m"
set "OLLAMA_CONTEXT_LENGTH=32768"
rem Bound reusable prompt snapshots, not the active model context or weights.
set "LLAMA_ARG_CACHE_RAM=1024"
rem LENO has 12 logical processors. 0x3FF permits 10, reserving 2 for Windows.
start "" /B /BELOWNORMAL powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\wamp\www\open-webui\ollama-cpu-guardian.ps1"
start "" /B /BELOWNORMAL /AFFINITY 3FF /WAIT "C:\wamp\www\open-webui\ollama\ollama.exe" serve >> "C:\wamp\www\open-webui\ollama.log" 2>&1
