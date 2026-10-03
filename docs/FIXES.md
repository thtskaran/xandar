# Review-only fix proposals

A selected finding can prepare up to eight cited support files from the pinned source manifest. Proposed diffs are limited to four modified files, 48 KB and 300 changed lines. Source and total context limits are 64 KB and 96 KB. Revision, hashes, exact context and withheld source ranges are checked. Proposals are never applied automatically and are not reported as tested fixes.

A durable cache keys proposals by source, finding, provider and prompt schema. It distinguishes missing, stale, blocked, generating, proposed, abstained and failed states. Explicit retry is required after a terminal failure. Historical proposals are retained with unverified freshness; interrupted generation is reconciled conservatively.

Optional local batch preparation is preview-only by default:

```bash
node scripts/generate-fixes.mjs --run=YOUR_SAVED_RUN_UUID --max-requests=2
```

Review the printed destination and scope. Adding `--execute` explicitly authorizes provider requests and model usage. The supplied request limit is a cumulative bound for the saved job. Processing is sequential, existing proposals and terminal cache states are skipped, and there are no automatic retries. Reaching the bound stops the command; unknown outcomes require manual inspection of the durable cache. No provider requests were made to prepare this publication.
