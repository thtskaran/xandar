#!/usr/bin/env bash
set +x
set -euo pipefail
# This script owns a child shell: credentials never modify the caller's environment.
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
SAVE_ENV=0
case "${1:-}" in
  --save-env) SAVE_ENV=1 ;;
  '') ;;
  *) echo 'Usage: bash scripts/configure-azure.sh [--save-env]' >&2; exit 1 ;;
esac
if [[ $# -gt 1 ]]; then echo 'Too many arguments.' >&2; exit 1; fi
if [[ ! -t 0 || ! -t 1 ]]; then
  echo 'Run this command yourself in an interactive local terminal. Never send your API key in chat.' >&2
  exit 1
fi
command -v node >/dev/null
command -v ss >/dev/null
if [[ ${PORT:-4317} != 4317 ]]; then
  echo 'This setup supports the verified Xander port 4317 only. Unset PORT first.' >&2
  exit 1
fi
printf '%s\n' 'Azure setup — no request is made until you review context and click Send in Xander.'
node scripts/azure-launch-preflight.mjs inspect
XANDER_SETUP_DEFAULT_ENDPOINT=''
printf '%s\n' "Enter the inference base for your own Azure resource. No endpoint is preconfigured."
read -r -p 'Azure HTTPS resource /openai/v1/ URL (required): ' XANDER_SETUP_ENDPOINT
XANDER_SETUP_ENDPOINT=${XANDER_SETUP_ENDPOINT:-$XANDER_SETUP_DEFAULT_ENDPOINT}
read -r -p 'Azure deployment name [gpt-6.1-sol]: ' XANDER_SETUP_DEPLOYMENT
XANDER_SETUP_DEPLOYMENT=${XANDER_SETUP_DEPLOYMENT:-gpt-6.1-sol}
export XANDER_SETUP_ENDPOINT XANDER_SETUP_DEPLOYMENT
node scripts/azure-launch-preflight.mjs validate
read -r -p 'Restart only the verified Xander server with these settings? [y/N] ' XANDER_SETUP_CONFIRM
if [[ "$XANDER_SETUP_CONFIRM" != y && "$XANDER_SETUP_CONFIRM" != Y ]]; then
  echo 'Setup cancelled; running server unchanged.'
  exit 0
fi
if [[ "$SAVE_ENV" == 1 ]]; then
  read -r -p 'Save the key in plaintext in an owner-only .env file on this machine? Type SAVE to confirm: ' XANDER_SETUP_SAVE_CONFIRM
  if [[ "$XANDER_SETUP_SAVE_CONFIRM" != SAVE ]]; then echo 'Save cancelled; server and .env unchanged.'; exit 0; fi
fi
read -r -s -p 'Azure API key (hidden; enter directly here): ' AZURE_OPENAI_API_KEY
printf '\n'
if [[ -z "$AZURE_OPENAI_API_KEY" || ${#AZURE_OPENAI_API_KEY} -gt 4096 || "$AZURE_OPENAI_API_KEY" == *[!\!-~]* ]]; then
  unset AZURE_OPENAI_API_KEY
  echo 'Invalid key format; running server unchanged.' >&2
  exit 1
fi
export AZURE_OPENAI_API_KEY
export AZURE_OPENAI_ENDPOINT="$XANDER_SETUP_ENDPOINT"
export AZURE_OPENAI_DEPLOYMENT="$XANDER_SETUP_DEPLOYMENT"
export XANDER_AZURE_ENABLED=1
unset XANDER_SETUP_ENDPOINT XANDER_SETUP_DEPLOYMENT XANDER_SETUP_CONFIRM
if [[ "$SAVE_ENV" == 1 ]]; then node scripts/save-azure-env.mjs; fi
unset XANDER_SETUP_SAVE_CONFIRM XANDER_SETUP_DEFAULT_ENDPOINT SAVE_ENV
node scripts/azure-launch-preflight.mjs stop
printf '%s\n' 'Open http://127.0.0.1:4317/answers.html' 'Select Synthetic JuiceShop company → Prepare local context → review evidence → check consent → Send reviewed context to Azure.' 'Configured status checks settings only. Your Send action performs the first live request.'
exec bash scripts/start-xander.sh
