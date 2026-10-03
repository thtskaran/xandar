# Optional local Laya advisory

Laya is an optional CPU-only review-queue advisory. Its scores are uncalibrated and are not vulnerability probabilities or independent validation. It receives a small cited finding summary, not raw source bodies. Advisories are stored separately and do not mutate findings. Provider analysis remains a separate optional feature.

```bash
bash scripts/install-laya.sh
bash scripts/start-laya.sh --allow-model-download
```

Installation uses only `.runtime/laya-venv`, with `PIP_REQUIRE_VIRTUALENV=true`. No system Python packages are installed. The initial model download is explicit; subsequent `bash scripts/start-laya.sh` runs offline against the local cache. All weights, caches, environment files and advisory results are ignored by Git. Startup binds `127.0.0.1:8000`, uses four CPU threads and one concurrent request. To expose the optional control in Xander, set `XANDER_LAYA_ENABLED=1` when starting Xander.

Pinned code: Laya 0.3.24, commit `fa9a2a7070b1789912a49ae24603bbfb1a78b001` from https://github.com/NandhaKishorM/laya . English model revision: `55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851`. The install script records resolved dependency versions locally. Code and model declare Apache-2.0; their upstream licenses apply. They are downloaded separately and are not bundled in this repository.

The adapter checks loopback destination, model revision and truncation diagnostics. Unavailable or rejected advisory responses remain unavailable; no result is fabricated. Unit tests use injected mock transports and do not download models or invoke an external provider.
