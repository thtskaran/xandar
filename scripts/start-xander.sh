#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
mkdir -p .runtime
chmod 700 .runtime
command -v podman >/dev/null || { echo 'This saved storefront uses rootless Podman. Docker was inspected but has no matching instance. Install/use Podman or explicitly migrate; no native fallback is performed.' >&2; exit 1; }
# Never silently create a second storefront or accept a public binding.
if ! podman container exists xander-juice-shop; then
 echo 'Saved xander-juice-shop is absent. Run scripts/install-storefront.sh once after reviewing juice/Containerfile.' >&2
 exit 1
fi
podman inspect xander-juice-shop | node --input-type=module -e '
let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s)[0];const ports=x.HostConfig.PortBindings;const p=ports?.["3000/tcp"];if(!p||p.length!==1||p[0].HostIp!=="127.0.0.1"||p[0].HostPort!=="3000"||Object.keys(ports).length!==1||x.Config.Labels?.["ai.xander.local-lab"]!=="persistent-v19.0.0")throw Error("Unexpected storefront configuration; refusing startup.");'
podman start xander-juice-shop >/dev/null
# Reuse an already running Xander only when its capture endpoint is present.
PORT=${PORT:-4317}
if curl --noproxy '*' -fsS "http://127.0.0.1:$PORT/api/capture/status" >/dev/null 2>&1; then
 echo "Xander already running: http://127.0.0.1:$PORT/ | Storefront: http://127.0.0.1:3000"
 exit 0
fi
if [[ -z ${XANDER_PLAYWRIGHT_MODULE:-} && ! -d node_modules/playwright ]]; then
 echo 'Install the pinned Playwright dependency, or set XANDER_PLAYWRIGHT_MODULE to an existing approved Playwright index.mjs.' >&2; exit 1
fi
# Foreground process keeps ownership clear; Ctrl+C stops Xander browser capture, not unrelated apps.
echo "Xander: http://127.0.0.1:$PORT/ | Storefront: http://127.0.0.1:3000"
PORT="$PORT" exec node server.mjs
