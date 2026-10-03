# Architecture and limits

The Node server serves the UI and mounts independent vault, capture, Azure knowledge, saved-analysis and forecast handlers behind loopback Host/Origin guards.

- Vault/extract/knowledge/seed modules retain source citations and compute deterministic financial summaries.
- Office extraction uses a minimal environment, private temporary directory and bounded worker resources. No OCR, formula evaluation or macros. Resource limits are not a filesystem/network sandbox.
- Browser capture uses a dedicated sandboxed Chromium profile and exact local storefront scope. Sanitized observations are not security verification.
- Workspace analysis validates source IDs, graph IDs/edges and allowed candidate statuses, saves input hashes and handles cancellation. Citation membership does not independently establish semantic truth or exploitability.
- Graph layout handles dependency layers and cycles. Nodes are logical components of one monolith, not deployed microservices. Colors show concern association, not incident likelihood or measured severity.
- Operating forecasts use owner-reviewed rates, shares, durations and capacity. Attempts are not unique customers; recovery clearance requires capacity above ongoing arrivals. Low/reference/high values are scenario envelopes, not confidence intervals.

The primary journey is overview → evidence review → saved business-first results. Compatibility APIs and the older explicitly curated map remain, but company/evidence onboarding is absent from primary navigation. Saved private state belongs under .runtime and never in Git.
