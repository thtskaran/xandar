#!/usr/bin/env bash
set -euo pipefail
export PIP_REQUIRE_VIRTUALENV=true
xander_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
xander_laya_venv="$xander_root/.runtime/laya-venv"
python3 -c 'import sys; assert sys.version_info >= (3,10), "Laya requires Python 3.10 or newer"'
python3 -m venv "$xander_laya_venv"
"$xander_laya_venv/bin/python" -m pip install 'torch==2.14.1+cpu' --index-url https://download.pytorch.org/whl/cpu
"$xander_laya_venv/bin/python" -m pip install 'laya[serve] @ git+https://github.com/NandhaKishorM/laya.git@fa9a2a7070b1789912a49ae24603bbfb1a78b001'
"$xander_laya_venv/bin/python" -m pip freeze > "$xander_root/.runtime/laya-installed-packages.txt"
printf '%s\n' 'Pinned Laya 0.3.24 code installed. Dependency versions recorded. No inference service was started.' 'Model weights are separate; see docs/LAYA.md before starting.'
