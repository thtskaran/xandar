# Xander · Juice Shop workspace

A local workspace for reviewing OWASP Juice Shop source, ordinary browser observations and generated business reference data. Optional Azure analysis creates saved, cited candidate assessments and a logical-component map. Business impact opens first; technical evidence is one click away. Assessments are not exploit validation. Forecasts require reviewed assumptions.

## Setup

Requires Node22+, npm and rootless Podman. Optional Office/PDF extraction requires Python3 with Linux resource limits.

```bash
npm ci
npx playwright install chromium
python3 -m venv .venv
.venv/bin/python -m pip install --target vendor/office -r requirements-office.txt
bash scripts/install-storefront.sh
bash scripts/start-xander.sh
```

Review the pinned `juice/Containerfile` before installation. Xander binds http://127.0.0.1:4317/ and Juice Shop http://127.0.0.1:3000/. Keep the terminal open: the launcher is foreground-only. Existing named containers and volumes are preserved. No model request runs at startup.

The Python install is optional unless Office/PDF extraction is required. Playwright is pinned and uses its locally installed Chromium by default; optional XANDER_PLAYWRIGHT_MODULE and XANDER_CHROMIUM overrides remain supported.

## Evidence and provider configuration

The committed source packet is a reviewed subset of pinned public Juice Shop source. Recorded traffic, private runtime, saved provider answers and uploaded originals are excluded. A fresh checkout generates the fictional business reference corpus locally; those records are not actual commercial data.

Use Browser observations for ordinary local shopping. After stopping capture, explicitly refresh the local analysis checkpoint if wanted:

```bash
cp .runtime/capture/capture.json evidence/ordinary-capture-expanded.json
```

The checkpoint is ignored by Git. Without it, analysis has source and generated context but no traffic observations. Historical coverage metadata is not distributed; its optional panel may report unavailable.

Run `bash scripts/configure-azure.sh --save-env` yourself in a local terminal. Replace the placeholder endpoint with your Azure resource, confirm the deployment and enter the key only at the hidden prompt. `.env` stays private and ignored. Review the exact bounded context and explicitly authorize each model request in the UI.

## Checks

```bash
npm run check
npm run test:workspace
npm run test:workspace-v2
```

The focused suite uses mocked provider responses and checks arithmetic, persistence and ordinary capture/vault behavior. Legacy `npm test` also includes older synthetic security fixtures; snapshot preparation did not run them.

See [architecture](docs/ARCHITECTURE.md), [provenance](docs/PROVENANCE.md), [reproducibility](docs/REPRODUCIBILITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md). Original Xander code is marked UNLICENSED pending an owner licensing decision; third-party licenses remain applicable.

## Updated workspace

The workspace now includes a pinned full-source inventory, an interactive component and endpoint map, resumable bounded analysis, conditional forecasts, and durable review-only fix proposals. See [workspace v2](docs/WORKSPACE-V2.md), [fix proposals](docs/FIXES.md), and the optional isolated [Laya setup](docs/LAYA.md). Private captures and saved analysis results are deliberately absent from this public repository.
