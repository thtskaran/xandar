#!/usr/bin/env bash
set -euo pipefail
podman stop xander-juice-shop
# No volumes, captures, browser profiles or unrelated containers are removed.
