#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
command -v podman >/dev/null
if podman container exists xander-juice-shop; then echo 'Existing storefront preserved; use start-xander.sh.'; exit 0; fi
if command -v docker >/dev/null && docker ps -a --format '{{.Names}}' 2>/dev/null | rg -q '^xander-juice-shop$'; then echo 'Docker already has xander-juice-shop; inspect it before proceeding.' >&2; exit 1; fi
podman build -t localhost/xander-juice:19.0.0-lifecycle2 -f juice/Containerfile juice
podman network exists xander-juice-isolated || podman network create --internal xander-juice-isolated >/dev/null
# Named volumes copy up the image seed assets on first creation; never use empty host bind directories here.
podman create --name xander-juice-shop --network xander-juice-isolated \
 -p 127.0.0.1:3000:3000 \
 -v xander-juice-data:/juice-shop/data \
 -v xander-juice-ftp:/juice-shop/ftp \
 -v xander-juice-uploads:/juice-shop/frontend/dist/frontend/assets/public/images/uploads \
 localhost/xander-juice:19.0.0-lifecycle2
