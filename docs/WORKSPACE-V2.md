# Workspace v2

The committed inventory covers 206 eligible application files in 38 evidence batches at OWASP Juice Shop revision `36870cbbdfe7864698e1adf644c7bf772f67ebb7` (19.0.0). It records source hashes, imports, route registrations and exclusions. This is a static inventory, not a semantic call graph or runtime proof. Ordinary recorded traffic can be joined locally; this repository contains no private browsing capture.

For local source verification and the source-review tests, install the matching public checkout:

```bash
git clone https://github.com/juice-shop/juice-shop.git juice/source
git -C juice/source checkout --detach 36870cbbdfe7864698e1adf644c7bf772f67ebb7
npm run test:source-review
```

The server defaults to `juice/source`; `XANDER_SOURCE_ROOT` can select another checkout of the same pinned revision. The checkout is ignored by Git.

The map supports folder navigation, search, filtering and zoom. Component selections scope evidence by path and hash. Bounded provider analysis persists progress, supports cancellation and resume, and distinguishes partial results and missing context. Provider requests require explicit consent. Reported token usage is not a billing estimate. Source matches remain candidates; observations and user-supplied results never become independently verified security findings.

The compact workspace keeps the issue queue and selected detail separately scrollable. Business and technical views, run selection and issue selection survive navigation. Conditional forecasts depend on explicit business assumptions. Fictional reference data remains separate from uploads and actual observations.
