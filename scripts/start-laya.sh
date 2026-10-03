#!/usr/bin/env bash
set -euo pipefail
xander_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
xander_laya_venv="$xander_root/.runtime/laya-venv"
if [[ ! -x "$xander_laya_venv/bin/laya-serve" ]]; then printf '%s\n' 'Run bash scripts/install-laya.sh first.' >&2; exit 1; fi
if [[ "${1:-}" == '--allow-model-download' ]]; then
 export HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0
elif [[ $# -eq 0 ]]; then
 export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
else
 printf '%s\n' 'Usage: bash scripts/start-laya.sh [--allow-model-download]' >&2; exit 1
fi
export LAYA_HOST=127.0.0.1 LAYA_PORT=8000 LAYA_DEVICE=cpu LAYA_MODELS=english LAYA_PRELOAD=1
export LAYA_DEFAULT_MODEL=english LAYA_AUTO_TASK=0 LAYA_JEV_STRICT=0 LAYA_MAX_CONCURRENT=1 LAYA_MAX_TOKEN_BUDGET=512
export LAYA_REVISION=55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851
export LAYA_ROOT_PATH='' LAYA_API_KEY=''
export HF_HOME="$xander_root/.runtime/laya-cache" HF_HUB_DISABLE_IMPLICIT_TOKEN=1
export LAYA_THREADS=4 OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 TOKENIZERS_PARALLELISM=false
printf '%s\n' 'Starting local optional advisory at 127.0.0.1:8000 with pinned English checkpoint.' 'Without --allow-model-download, uncached weights fail offline; no download is attempted.'
exec "$xander_laya_venv/bin/laya-serve"
