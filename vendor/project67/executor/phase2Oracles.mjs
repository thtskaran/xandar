/**
 * hunter-v2 Phase 2 — the verification-wall oracles (Builder B).
 *
 * Three DETERMINISTIC, FP-bounded oracles that consume an invariant-violation
 * `kill_test` + task_result(s) and return a verdict. There is **NO LLM in the
 * admit/reject path** — the proposer (Builder A's InvariantStore) is never the
 * judge. Each oracle is a pure function of its inputs (§5.1, §5.4).
 *
 * SHARED INTERFACE (both builders conform):
 *   kill_test = { kind, field, target_endpoint, violation_predicate, evidence_refs }
 *     kind ∈ { range_violation, client_only, cross_actor_read,
 *              work_amplification, single_use, off_wire_propagation }
 *
 *   oracle(kill_test, task_result(s)) → { verdict, evidence, fp_controlled }
 *     verdict ∈ 'confirmed' | 'refuted' | 'inconclusive'
 *     fp_controlled: true once the FP guard for the kind has been applied to a
 *                    confirmed/refuted decision; false when we bail to
 *                    inconclusive for lack of FP-controllable evidence.
 *
 * FP target ≤ 0.10 vs hard negatives. The guards below are the mechanism:
 *   - cross_actor_read  → require a *content* match on B's specific bytes,
 *                         minus A's own/public baseline (not a status/similarity match).
 *   - work_amplification→ require a *monotone* latency correlation across a multi-probe
 *                         varying-input sweep + an amplification gate (replaces the
 *                         single-SLEEP static threshold); FP-bound against jitter.
 *   - client_only/range → require the violation_predicate to hold AND a concrete
 *                         illegal field/value to be echoed exactly.
 */

import { evaluatePredicate, responseEchoesFieldValue } from "./expectationOracle.mjs";
import { pValueFromSpearman, benjaminiHochberg, TargetFdrController, DEFAULT_Q } from "../verify/fdr.mjs";

// ── Tunable thresholds (overridable per-call via killTest.thresholds) ──────
export const ORACLE_DEFAULTS = Object.freeze({
  // cross_actor_read
  min_canary_len: 8,          // a sensitive token shorter than this can't be FP-controlled
  // work_amplification / scalesWork
  min_probes: 4,              // a line can't be fit from < 4 points
  min_distinct_x: 3,          // need real variation in the controlled input
  min_corr: 0.9,              // Spearman ρ for "monotone" (confirm gate)
  low_corr: 0.5,              // below this ρ → flat/jittery → refute
  min_amp: 3,                 // max/min metric ratio for "amplification" (confirm gate)
  flat_amp: 1.5,              // below this ratio → no amplification → refute
  min_abs_ms: 40,             // absolute floor on peak latency (avoid micro-noise FPs)
});

// Common, low-entropy tokens that must never count as a "sensitive byte" match.
const GENERIC_TOKENS = new Set([
  "true", "false", "null", "undefined", "success", "error", "unauthorized",
  "forbidden", "notfound", "not found", "ok", "status", "message", "data",
  "result", "results", "email", "username", "password", "object", "string",
]);

function thr(killTest, key) {
  const t = killTest && killTest.thresholds;
  if (t && typeof t[key] === "number") return t[key];
  return ORACLE_DEFAULTS[key];
}

// ── body / token helpers ───────────────────────────────────────────────────

/** Normalize a response-ish input into a raw body string (case preserved). */
export function bodyOf(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  const r = x.raw_result || x;
  const b = r.body_preview ?? r.body ?? r.text ?? r.response?.body ?? "";
  return typeof b === "string" ? b : JSON.stringify(b);
}

function statusOf(x) {
  if (x == null) return 0;
  const r = x.raw_result || x;
  return Number(r.status ?? r.actor_a?.status ?? r.response?.status ?? 0) || 0;
}

/** A token is "specific" enough to FP-control a cross-actor read on. */
export function isSpecificToken(tok) {
  const t = String(tok || "").trim();
  if (t.length < ORACLE_DEFAULTS.min_canary_len) return false;
  if (GENERIC_TOKENS.has(t.toLowerCase())) return false;
  // require some alphanumeric density (not pure punctuation / whitespace)
  const alnum = (t.match(/[A-Za-z0-9]/g) || []).length;
  return alnum >= 6;
}

/** Extract candidate sensitive tokens (ids/tokens/emails) from a body. */
export function extractSensitiveTokens(body) {
  const s = String(body || "");
  const out = new Set();
  // emails
  for (const m of s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) out.add(m);
  // long id/token-ish runs
  for (const m of s.match(/[A-Za-z0-9][A-Za-z0-9._:\-+/]{7,}/g) || []) out.add(m);
  return [...out].filter(isSpecificToken);
}

// ── (1) cross-actor differential — canary-BACFuzz ───────────────────────────
/**
 * kind = cross_actor_read. Actor A's request for resource r returns actor B's
 * *sensitive bytes* ⇒ CONFIRMED regardless of HTTP status (the silent-200
 * access-control engine). FP guard: require a content match on B-specific tokens
 * that are NOT present in A's own/public baseline; bare status/similarity is
 * never sufficient.
 *
 * results: { responseA, responseB, baselineA? }  (each: string | result-ish object)
 *          — also accepts a single AUTHZ_PROBE raw_result via { actor_a, actor_b } / previews.
 * killTest.canary | killTest.canaries: explicit B-secret(s) (preferred, sound).
 */
export function crossActorReadOracle(killTest = {}, results = {}) {
  const r = results || {};
  // AUTHZ_PROBE stores status metadata under actor_a/actor_b and response bytes
  // under previews. Prefer the actual bytes when both forms are present.
  let bodyA = bodyOf(r.responseA ?? r.previews?.actor_a ?? r.actor_a ?? r.a);
  let bodyB = bodyOf(r.responseB ?? r.previews?.actor_b ?? r.actor_b ?? r.b);
  const baselineA = bodyOf(r.baselineA ?? r.aOwnBaseline ?? "");
  // G49: the authenticated-NON-VICTIM canary-ABSENT control (a 3rd `anon`/other-user
  // capture, §9 L640-643). A token that ALSO appears here is shared / not victim-
  // specific (the canary-absent hard-negative vector) and must NEVER confirm.
  const control = bodyOf(
    r.control ?? r.anon ?? r.nonVictim ?? r.canaryAbsentControl ?? r.aControl ?? r.previews?.control ?? ""
  );
  const controlProvided =
    (r.control ?? r.anon ?? r.nonVictim ?? r.canaryAbsentControl ?? r.aControl ?? r.previews?.control ?? null) != null;
  const statusA = statusOf(r.responseA ?? r.actor_a ?? r);

  // Determine B's sensitive tokens (the canary).
  let canaries = [];
  if (Array.isArray(killTest.canaries)) canaries = killTest.canaries.slice();
  else if (killTest.canary) canaries = [killTest.canary];
  canaries = canaries.map((c) => String(c)).filter(isSpecificToken);

  if (canaries.length === 0) {
    // Derive from B's body, subtracting A's own baseline + the non-victim control.
    canaries = extractSensitiveTokens(bodyB).filter(
      (tok) => !baselineA.includes(tok) && !control.includes(tok)
    );
  }

  if (canaries.length === 0) {
    return {
      verdict: "inconclusive",
      evidence: {
        reason: "no FP-controllable sensitive token available in B's response",
        statusA,
        control_provided: controlProvided,
      },
      fp_controlled: false,
    };
  }

  // Tokens that leaked into A AND are absent from A's own baseline.
  const inAMinusBaseline = canaries.filter((tok) => bodyA.includes(tok) && !baselineA.includes(tok));
  // Victim-specific leak: ALSO absent from the non-victim control.
  const matched = inAMinusBaseline.filter((tok) => !control.includes(tok));
  // Canary-ABSENT FP: present in A but ALSO present in the non-victim control → shared.
  const sharedWithControl = inAMinusBaseline.filter((tok) => control.includes(tok));

  // Split FP reporting (canary-present vs canary-absent), §9 L643.
  const fp_modes = {
    canary_present: matched.length > 0,                 // victim-specific bytes leaked
    canary_absent_control_provided: controlProvided,
    canary_absent_shared_tokens: sharedWithControl.map(redactToken),
  };

  if (matched.length > 0) {
    return {
      verdict: "confirmed",
      evidence: {
        kind: "cross_actor_read",
        target_endpoint: killTest.target_endpoint || null,
        field: killTest.field || null,
        statusA, // recorded but NOT used as the gate — silent-200 still confirms
        matched_tokens: matched.map(redactToken),
        content_match: true,
        control_provided: controlProvided,
        fp_modes,
      },
      fp_controlled: true,
    };
  }

  // Bytes leaked into A but they ALSO appear in the non-victim control → not a leak.
  if (sharedWithControl.length > 0) {
    return {
      verdict: "refuted",
      evidence: {
        kind: "cross_actor_read",
        statusA,
        reason: "candidate bytes also present in the authenticated non-victim control (shared / not victim-specific)",
        content_match: false,
        control_provided: controlProvided,
        fp_modes,
      },
      fp_controlled: true,
    };
  }

  // A got only its own / an empty / a benign response → no cross-actor leak.
  return {
    verdict: "refuted",
    evidence: {
      kind: "cross_actor_read",
      statusA,
      reason: bodyA.trim() === ""
        ? "A's response empty — no B bytes leaked"
        : "A's response contains none of B's sensitive tokens",
      content_match: false,
      control_provided: controlProvided,
      fp_modes,
    },
    fp_controlled: true,
  };
}

function redactToken(t) {
  const s = String(t);
  if (s.includes("@")) {
    const [u, d] = s.split("@");
    return `${u.slice(0, 2)}***@${d}`;
  }
  return s.length <= 10 ? s : `${s.slice(0, 4)}…${s.slice(-3)}`;
}

// ── statistics (pure) ───────────────────────────────────────────────────────

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  if (s.length === 0) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(a) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

/** Average-tie ranks (1-based). */
function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const out = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/** Spearman rank correlation — robust to outliers, captures monotonicity. */
export function spearman(xs, ys) {
  return pearson(ranks(xs), ranks(ys));
}

/** Normalize a probe list into [{ x, metric }] using per-x replicate medians. */
function normalizeProbes(rawProbes, metricKeys) {
  const list = Array.isArray(rawProbes) ? rawProbes : (rawProbes?.probes || []);
  const byX = new Map();
  for (const p of list) {
    if (!p) continue;
    const x = Number(p.x ?? p.value ?? p.input ?? p.size ?? p.len);
    if (!Number.isFinite(x)) continue;
    let metric;
    if (Array.isArray(p.latencies)) metric = median(p.latencies.map(Number));
    else {
      for (const k of metricKeys) {
        if (p[k] != null && Number.isFinite(Number(p[k]))) { metric = Number(p[k]); break; }
      }
    }
    if (!Number.isFinite(metric)) continue;
    if (!byX.has(x)) byX.set(x, []);
    byX.get(x).push(metric);
  }
  return [...byX.entries()]
    .map(([x, ms]) => ({ x, metric: median(ms) }))
    .sort((a, b) => a.x - b.x);
}

/** Count the RAW measurements in a probe list (replicates counted individually). */
function countRawProbes(rawProbes, metricKeys) {
  const list = Array.isArray(rawProbes) ? rawProbes : (rawProbes?.probes || []);
  let n = 0;
  for (const p of list) {
    if (!p) continue;
    const x = Number(p.x ?? p.value ?? p.input ?? p.size ?? p.len);
    if (!Number.isFinite(x)) continue;
    if (Array.isArray(p.latencies)) { n += p.latencies.filter((v) => Number.isFinite(Number(v))).length; continue; }
    for (const k of metricKeys) { if (p[k] != null && Number.isFinite(Number(p[k]))) { n += 1; break; } }
  }
  return n;
}

/**
 * Shared monotone-amplification fit used by the latency + scalesWork oracles.
 * Confirmed: ρ ≥ min_corr AND amp ≥ min_amp AND peak ≥ min_abs (latency only).
 * Refuted:   amp < flat_amp (no amplification) OR ρ < low_corr (flat/jittery).
 */
function fitMonotone(killTest, points, { requireAbs = false, rawCount = null } = {}) {
  const minDistinct = thr(killTest, "min_distinct_x");
  const minProbes = thr(killTest, "min_probes");
  // G43: enforce min_probes (≥4) — a line fit from < min_probes DISTINCT points (or
  // < min_probes raw measurements) is too weak to FP-bound; refuse to confirm/refute.
  if (points.length < minDistinct || points.length < minProbes) {
    return { verdict: "inconclusive", fp_controlled: false, stats: { reason: "too few distinct inputs", n: points.length, min_probes: minProbes } };
  }
  if (rawCount != null && rawCount < minProbes) {
    return { verdict: "inconclusive", fp_controlled: false, stats: { reason: "too few probes", raw_probes: rawCount, min_probes: minProbes } };
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.metric);
  const rho = spearman(xs, ys);
  const minMetric = Math.min(...ys.filter((v) => v > 0));
  const maxMetric = Math.max(...ys);
  const amp = (Number.isFinite(minMetric) && minMetric > 0) ? maxMetric / minMetric : (maxMetric > 0 ? Infinity : 0);

  const minCorr = thr(killTest, "min_corr");
  const lowCorr = thr(killTest, "low_corr");
  const minAmp = thr(killTest, "min_amp");
  const flatAmp = thr(killTest, "flat_amp");
  const minAbs = thr(killTest, "min_abs_ms");

  // One-sided p-value for the positive (amplifying) rank correlation — the per-test
  // statistic the per-target Benjamini–Hochberg FDR cap consumes (G17 / §R-GATE7).
  const p_value = round(pValueFromSpearman(rho, points.length));
  const stats = { rho: round(rho), amp: round(amp), maxMetric, minMetric: Number.isFinite(minMetric) ? minMetric : 0, n: points.length, p_value, raw_probes: rawCount == null ? points.length : rawCount };

  // Refute: no amplification, or non-monotone/flat (FP-bound against jitter).
  if (amp < flatAmp || rho < lowCorr) {
    return {
      verdict: "refuted",
      fp_controlled: true,
      stats: { ...stats, reason: amp < flatAmp ? "no amplification (flat metric)" : "non-monotone / jittery (low correlation)" },
    };
  }

  const absOk = requireAbs ? maxMetric >= minAbs : true;
  if (rho >= minCorr && amp >= minAmp && absOk) {
    return { verdict: "confirmed", fp_controlled: true, stats };
  }

  return {
    verdict: "inconclusive",
    fp_controlled: true,
    stats: { ...stats, reason: !absOk ? "peak below absolute floor" : "monotone but weak amplification/correlation" },
  };
}

function round(v) {
  if (!Number.isFinite(v)) return v;
  return Math.round(v * 1000) / 1000;
}

// ── (2) statistical latency oracle — work_amplification / ReDoS ─────────────
/**
 * kind = work_amplification. Multi-probe sweep varying a controlled input
 * magnitude `x` against a `latency_ms`; CONFIRMED only on a monotone latency
 * correlation + an amplification gate. Replaces the single-SLEEP static
 * threshold. FP-bound against jitter via Spearman ρ + per-x replicate medians.
 *
 * results: [{ x, latency_ms }] | { probes: [...] }   (latencies[] for replicates)
 */
export function latencyOracle(killTest = {}, results = {}) {
  const keys = ["latency_ms", "elapsed_ms", "metric", "ms"];
  const points = normalizeProbes(results, keys);
  const fit = fitMonotone(killTest, points, { requireAbs: true, rawCount: countRawProbes(results, keys) });
  return {
    verdict: fit.verdict,
    evidence: {
      kind: "work_amplification",
      target_endpoint: killTest.target_endpoint || null,
      field: killTest.field || null,
      metric: "latency_ms",
      ...fit.stats,
    },
    fp_controlled: fit.fp_controlled,
  };
}

// ── (3) affordance probe — scalesWork + client_only ─────────────────────────
/**
 * Active-pass oracle. Two modes (auto-selected by the inputs / kind):
 *
 *  (a) scalesWork — a client param controls server work. Provide a probe sweep
 *      [{ x, work }] (work = latency_ms | bytes | item_count). CONFIRMED on a
 *      monotone work correlation + amplification gate. Tags the Value/Field.
 *
 *  (b) client_only / range_violation — server accepts a UI-forbidden / out-of-
 *      range value. CONFIRMED when the violation_predicate holds against the
 *      server response AND a concrete illegal value is echoed. A status-only
 *      predicate without a bound value is never sufficient to confirm.
 */
export function affordanceProbeOracle(killTest = {}, results = {}) {
  const hasSweep = Array.isArray(results) || Array.isArray(results?.probes);
  if (hasSweep) return affordanceScalesWork(killTest, results);
  return affordanceClientOnly(killTest, results);
}

export function affordanceScalesWork(killTest = {}, results = {}) {
  const keys = ["work", "latency_ms", "elapsed_ms", "bytes", "size", "item_count", "count"];
  const points = normalizeProbes(results, keys);
  const fit = fitMonotone(killTest, points, { requireAbs: false, rawCount: countRawProbes(results, keys) });
  return {
    verdict: fit.verdict,
    evidence: {
      kind: "scalesWork",
      affordance: "scalesWork",
      target_endpoint: killTest.target_endpoint || null,
      field: killTest.field || null,
      tagged: { Value: killTest.field || null, Field: killTest.field || null },
      ...fit.stats,
    },
    fp_controlled: fit.fp_controlled,
  };
}

export function affordanceClientOnly(killTest = {}, results = {}) {
  const result = Array.isArray(results) ? results[0] : (results?.response ?? results);
  const body = bodyOf(result);
  const status = statusOf(result);

  // The server "accepts" the forbidden value iff the violation predicate holds.
  // (Deterministic Phase-0 grammar; no LLM.) Absent a predicate, fall back to a
  // 2xx + value-echo acceptance test.
  const predicate = killTest.violation_predicate;
  let accepted;
  let predUsed = false;
  if (typeof predicate === "string" && predicate.trim()) {
    accepted = evaluatePredicate(predicate, { status, body, body_preview: body });
    predUsed = true;
  } else {
    accepted = status >= 200 && status < 300;
  }

  const illegalValue = killTest.illegal_value ?? killTest.forbidden_value ?? killTest.boundary_value;
  const hasIllegalValue = illegalValue !== undefined && illegalValue !== null;
  const forbidden = hasIllegalValue ? String(illegalValue) : null;
  const echoed = hasIllegalValue
    ? responseEchoesFieldValue(body, killTest.field, illegalValue)
    : null;

  if (accepted && !hasIllegalValue) {
    return {
      verdict: "inconclusive",
      evidence: {
        kind: killTest.kind || "client_only",
        status, predicate_used: predUsed, accepted: true,
        reason: "status predicate matched without a concrete illegal value",
      },
      fp_controlled: false,
    };
  }

  if (accepted && echoed === false) {
    return {
      verdict: "inconclusive",
      evidence: {
        kind: killTest.kind || "client_only",
        status, predicate_used: predUsed, accepted: true,
        reason: "server did not reject but forbidden value not observed echoed/persisted",
      },
      fp_controlled: true,
    };
  }

  if (accepted) {
    return {
      verdict: "confirmed",
      evidence: {
        kind: killTest.kind || "client_only",
        affordance: "client_only",
        target_endpoint: killTest.target_endpoint || null,
        field: killTest.field || null,
        tagged: { Value: forbidden, Field: killTest.field || null },
        status, predicate_used: predUsed,
        forbidden_value: forbidden, echoed,
      },
      fp_controlled: true,
    };
  }

  return {
    verdict: "refuted",
    evidence: {
      kind: killTest.kind || "client_only",
      status, predicate_used: predUsed,
      reason: "server rejected the UI-forbidden / out-of-range value",
    },
    fp_controlled: true,
  };
}

// ── (4) post-state ground-truth read — state_persistence (G18) ──────────────
/**
 * The SEPARATE post-state read (02-arch §2.5 L425-427). A range/client_only/
 * state_persistence violation is CONFIRMED only when, after the write is accepted,
 * an INDEPENDENT post-state read shows the illegal value PERSISTED — a 2xx that
 * echoes the value in its own write-response (or doesn't persist at all) is NOT a
 * confirm. This is the wall's "send violation_negation, check the request succeeds
 * AND the post-state ground-truth read confirms the violated quantity persisted."
 *
 * results: { write, post_state } | { write, postState } — each an executor envelope.
 *   write       — the response to the illegal write (must be accepted: predicate / 2xx).
 *   post_state  — an INDEPENDENT read of the resource AFTER the write.
 * killTest: { violation_predicate?, illegal_value | forbidden_value, expected_persisted_field? }
 */
export function postStatePersistenceOracle(killTest = {}, results = {}) {
  const r = results || {};
  const write = r.write ?? r.writeResult ?? r.acceptance ?? null;
  const post = r.post_state ?? r.postState ?? r.read ?? r.postcondition_read ?? null;

  if (write == null || post == null) {
    return {
      verdict: "inconclusive",
      evidence: { kind: killTest.kind || "state_persistence", reason: "requires both a write response and a SEPARATE post-state read" },
      fp_controlled: true,
    };
  }

  const writeStatus = statusOf(write);
  const writeBody = bodyOf(write);
  const predicate = killTest.violation_predicate;
  let accepted;
  if (typeof predicate === "string" && predicate.trim()) {
    accepted = evaluatePredicate(predicate, { status: writeStatus, body: writeBody, body_preview: writeBody });
  } else {
    accepted = writeStatus >= 200 && writeStatus < 300;
  }

  if (!accepted) {
    return {
      verdict: "refuted",
      evidence: { kind: killTest.kind || "state_persistence", write_status: writeStatus, reason: "server rejected the illegal write" },
      fp_controlled: true,
    };
  }

  // Ground-truth: the illegal value must be present in the INDEPENDENT post-state read.
  const illegal = (killTest.illegal_value ?? killTest.forbidden_value ?? killTest.boundary_value);
  const postBody = bodyOf(post);
  const postStatus = statusOf(post);

  if (illegal == null) {
    // No concrete illegal value to look for ⇒ we cannot ground-truth persistence.
    return {
      verdict: "inconclusive",
      evidence: { kind: killTest.kind || "state_persistence", write_status: writeStatus, post_status: postStatus, reason: "no illegal_value to confirm persistence against" },
      fp_controlled: true,
    };
  }

  const needle = String(illegal).toLowerCase();
  const persisted = postBody.toLowerCase().includes(needle);

  if (persisted) {
    return {
      verdict: "confirmed",
      evidence: {
        kind: killTest.kind || "state_persistence",
        target_endpoint: killTest.target_endpoint || null,
        field: killTest.field || killTest.expected_persisted_field || null,
        write_status: writeStatus, post_status: postStatus,
        illegal_value: String(illegal), persisted: true, persistence_verified: true,
      },
      fp_controlled: true,
    };
  }

  // Accepted on the wire but the value did NOT survive to the post-state read — the
  // write echoed but did not persist (clamped/dropped). NOT a confirm.
  return {
    verdict: "inconclusive",
    evidence: {
      kind: killTest.kind || "state_persistence",
      write_status: writeStatus, post_status: postStatus,
      illegal_value: String(illegal), persisted: false, persistence_verified: false,
      reason: "write accepted but illegal value NOT present in the post-state read (echo, not persistence)",
    },
    fp_controlled: true,
  };
}

// ── (5) single-use replay — single_use (G42 / G29) ──────────────────────────
/**
 * A single-use token (coupon/nonce) is consumed by its first acceptance. The
 * violation is wire-witnessable WITHOUT a planner: REPLAY the SAME token after it
 * was consumed; if the replay is ALSO accepted, the single-use contract is broken.
 * A bare 2xx to the endpoint is NOT a confirm — it must be a re-acceptance of the
 * SAME consumed token (proposer ≠ judge; deterministic).
 *
 * results: { first_use, replay } | { consumed, replay } | [firstUse, replay]
 *   first_use / consumed — the original (accepted) use of the token.
 *   replay               — re-submitting the SAME token after consumption.
 * killTest: { token, violation_predicate? }
 */
export function singleUseReplayOracle(killTest = {}, results = {}) {
  let firstUse = null, replay = null;
  if (Array.isArray(results)) {
    firstUse = results.length >= 2 ? results[0] : null;
    replay = results.length >= 2 ? results[results.length - 1] : (results.length === 1 ? null : null);
  } else if (results && typeof results === "object") {
    firstUse = results.first_use ?? results.consumed ?? results.firstUse ?? null;
    replay = results.replay ?? results.reuse ?? results.second ?? null;
  }

  if (!firstUse || !replay) {
    return {
      verdict: "inconclusive",
      evidence: { kind: "single_use", reason: "requires the original (consumed) use AND a replay of the SAME token" },
      fp_controlled: true,
    };
  }

  const token = killTest.token != null ? String(killTest.token) : null;
  const firstAccepted = statusOf(firstUse) >= 200 && statusOf(firstUse) < 400;
  const predicate = killTest.violation_predicate;
  const replayStatus = statusOf(replay);
  const replayBody = bodyOf(replay);
  let replayAccepted;
  if (typeof predicate === "string" && predicate.trim()) {
    replayAccepted = evaluatePredicate(predicate, { status: replayStatus, body: replayBody, body_preview: replayBody });
  } else {
    replayAccepted = replayStatus >= 200 && replayStatus < 400;
  }

  // FP guard: when a concrete token is named, the replay must carry THAT token.
  const tokenInReplay = token != null ? replayBody.includes(token) : true;

  if (!firstAccepted) {
    return {
      verdict: "inconclusive",
      evidence: { kind: "single_use", reason: "the original use was not accepted — nothing was consumed to replay" },
      fp_controlled: true,
    };
  }

  if (replayAccepted && tokenInReplay) {
    return {
      verdict: "confirmed",
      evidence: {
        kind: "single_use", target_endpoint: killTest.target_endpoint || null, field: killTest.field || null,
        token: token ? redactToken(token) : null, replay_status: replayStatus,
        reason: "the SAME token was accepted again after consumption — single-use contract broken",
      },
      fp_controlled: true,
    };
  }

  return {
    verdict: "refuted",
    evidence: {
      kind: "single_use", replay_status: replayStatus,
      reason: replayAccepted ? "replay accepted but the consumed token was not echoed (different datum)" : "the replayed token was rejected — single-use enforced",
    },
    fp_controlled: true,
  };
}

// ── (6) conservation — cross_actor_balance_differential (G30) ────────────────
/**
 * The conservation oracle (02-arch §2.5 L348-368; §6.4 L1652). A `conservation`
 * invariant (`Δbalance(A) == +refund ⇒ ∃ matching return(order)`) is confirmed by a
 * DETERMINISTIC ground-truth read, NOT a status: read balance(A) before+after the
 * suspect action, require it INCREASED, and confirm there is NO matching return
 * record. A balance read or a return-listing read that is unavailable degrades to
 * inconclusive ("field accepted, harm unproven") — never a false bug.
 *
 * results: { balance_before, balance_after, return_record? }
 *   balance_before / balance_after — numbers (or bodies carrying the balance field).
 *   return_record — the return-listing read; CONFIRMED requires its ABSENCE.
 * killTest: { balance_field?, expected_delta?, return_marker? }
 */
export function conservationBalanceOracle(killTest = {}, results = {}) {
  const r = results || {};
  const before = readBalance(r.balance_before ?? r.before, killTest.balance_field);
  const after = readBalance(r.balance_after ?? r.after, killTest.balance_field);

  if (before == null || after == null) {
    return {
      verdict: "inconclusive",
      evidence: { kind: "conservation", reason: "balance read capability missing (before/after) — harm unproven" },
      fp_controlled: true,
    };
  }

  const delta = after - before;
  const returnRecordPresent = hasReturnRecord(r.return_record ?? r.returns, killTest.return_marker);
  const returnReadAvailable = (r.return_record ?? r.returns ?? null) != null;

  if (delta <= 0) {
    return {
      verdict: "refuted",
      evidence: { kind: "conservation", balance_before: before, balance_after: after, delta, reason: "balance did not increase — conservation holds" },
      fp_controlled: true,
    };
  }

  if (!returnReadAvailable) {
    // Stated precondition (a return-listing read) absent ⇒ harm unproven, NOT reported.
    return {
      verdict: "inconclusive",
      evidence: { kind: "conservation", balance_before: before, balance_after: after, delta, reason: "no return-listing read capability — economic harm unproven (not reported)" },
      fp_controlled: true,
    };
  }

  if (delta > 0 && !returnRecordPresent) {
    return {
      verdict: "confirmed",
      evidence: {
        kind: "conservation", target_endpoint: killTest.target_endpoint || null, field: killTest.balance_field || killTest.field || null,
        balance_before: before, balance_after: after, delta, return_record: false,
        reason: "balance increased with NO matching return record — conservation violated",
      },
      fp_controlled: true,
    };
  }

  return {
    verdict: "refuted",
    evidence: { kind: "conservation", balance_before: before, balance_after: after, delta, return_record: true, reason: "balance increase has a matching return record — conservation holds" },
    fp_controlled: true,
  };
}

function readBalance(x, field) {
  if (x == null) return null;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const body = bodyOf(x);
  if (field) {
    const m = body.match(new RegExp(`"${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    if (m) return Number(m[1]);
  }
  const n = Number(body.trim());
  return Number.isFinite(n) ? n : null;
}

function hasReturnRecord(x, marker) {
  if (x == null) return false;
  if (Array.isArray(x)) return x.length > 0;
  const body = bodyOf(x);
  if (!body || body.trim() === "" || body.trim() === "[]" || body.trim() === "{}") return false;
  if (marker) return body.includes(String(marker));
  return true;
}

// ── (7) repro PoC — deterministic typed success predicate (repro_poc) ────────
/**
 * The repro-PoC oracle (02-arch §2.5 L394). The proposer binds a typed, deterministic
 * `success_predicate`; the wall replays the `action_sequence` and evaluates the
 * predicate against the FINAL result. NO LLM — the predicate is the Phase-0 grammar.
 *
 * results: the final executor envelope (or { final }).
 * killTest: { success_predicate }
 */
export function reproPocOracle(killTest = {}, results = {}) {
  const predicate = killTest.success_predicate || killTest.violation_predicate;
  if (typeof predicate !== "string" || !predicate.trim()) {
    return { verdict: "inconclusive", evidence: { kind: "repro_poc", reason: "no typed success_predicate" }, fp_controlled: false };
  }
  const final = Array.isArray(results) ? results[results.length - 1] : (results?.final ?? results);
  if (final == null) {
    return { verdict: "inconclusive", evidence: { kind: "repro_poc", reason: "no final result to evaluate the success predicate against" }, fp_controlled: true };
  }
  const status = statusOf(final);
  const body = bodyOf(final);
  const ok = evaluatePredicate(predicate, { status, body, body_preview: body });
  return {
    verdict: ok ? "confirmed" : "refuted",
    evidence: { kind: "repro_poc", target_endpoint: killTest.target_endpoint || null, status, predicate, reproduced: ok },
    fp_controlled: true,
  };
}

// ── (8) off-wire OOB — off_wire_propagation (G53) ───────────────────────────
/**
 * The off-wire/async propagation oracle. The violation cannot be seen on the wire;
 * the ONLY sound confirmation is an OOB callback to our `src/verify/oob.mjs` listener
 * carrying the unique per-probe correlation token, with the MANDATORY benign negative
 * control. Without a listener/receipt it is honestly inconclusive (never a guess).
 *
 * results / killTest must supply: { listener (OobListener), oob_token, benign_token? }.
 */
export function offWireOobOracle(killTest = {}, results = {}) {
  const r = results || {};
  const listener = r.listener ?? killTest.listener ?? null;
  const token = r.oob_token ?? killTest.oob_token ?? r.token ?? killTest.token ?? null;
  const benignToken = r.benign_token ?? killTest.benign_token ?? null;

  if (!listener || typeof listener.confirm !== "function" || !token) {
    return {
      verdict: "inconclusive",
      evidence: { kind: "off_wire_propagation", witness: "oob", reason: "no OOB listener / correlation token available (Phase-3 OOB)" },
      fp_controlled: true,
    };
  }
  const v = listener.confirm(token, { benignToken });
  return {
    verdict: v.verdict,
    evidence: { kind: "off_wire_propagation", witness: "oob", target_endpoint: killTest.target_endpoint || null, ...v.evidence },
    fp_controlled: v.fp_controlled,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// (9) SSTI differential — server-side template evaluation (H5 / RD-PLAN item 2)
// ════════════════════════════════════════════════════════════════════════════
/**
 * The SSTI arithmetic polyglots. Each `payload` is a template-language expression whose
 * server-side EVALUATION yields `evaluated`; a server that merely reflects input echoes
 * the literal `payload`, never `evaluated`. SINGLE SOURCE OF TRUTH — the mutation
 * generator emits exactly these, and the oracle checks exactly these (no drift).
 */
export const SSTI_ARITH_PAYLOADS = Object.freeze([
  { payload: "{{7*7}}", evaluated: "49" },      // Jinja2 / Twig / Nunjucks / Angular
  { payload: "${7*7}", evaluated: "49" },       // Freemarker / JSP-EL / Thymeleaf / JS template
  { payload: "#{7*7}", evaluated: "49" },       // Ruby / JSF-EL
  { payload: "<%= 7*7 %>", evaluated: "49" },   // ERB / EJS
]);

/**
 * The DISAMBIGUATOR (§H5). `{{7*'7'}}` multiplies an int by a string. Jinja2 coerces and
 * repeats → `7777777` (7 sevens). That value is IMPOSSIBLE to produce by reflection
 * (reflection echoes the literal `{{7*'7'}}`) or by coincidence (unlike a bare `49`),
 * so it is what rules out the "coincidental 49" false positive. A template-engine ERROR
 * signature (below) is an equally sound proof that a template engine parsed the payload.
 */
export const SSTI_DISAMBIGUATOR = Object.freeze({ payload: "{{7*'7'}}", evaluated: "7777777" });

/** CLOSED catalog of template-engine ERROR signatures — proof of template parsing/eval. */
export const SSTI_TEMPLATE_ERROR_SIGNATURES = Object.freeze([
  /jinja2\.exceptions\.\w+/i,
  /TemplateSyntaxError/,
  /TemplateAssertionError/,
  /jinja2\.\w*UndefinedError/,
  /Twig\\Error(?:_\w+|\\\w+)?/i,
  /twig[\\/](?:error|environment)/i,
  /freemarker\.core\.\w+/i,
  /FreeMarker template error/i,
  /org\.apache\.velocity\.\w+/i,
  /Smarty(?:CompilerException|Exception)/,
  /nunjucks[^\n]{0,40}(?:Error|error)/,
  /Liquid::(?:SyntaxError|Error)/,
]);

function matchTemplateError(body) {
  const s = String(body || "");
  for (const re of SSTI_TEMPLATE_ERROR_SIGNATURES) {
    const m = s.match(re);
    if (m) return String(m[0]).slice(0, 80);
  }
  return null;
}

/** Pull the base (arithmetic) + disambiguator responses out of the accepted shapes. */
function pickSstiResponses(results) {
  const r = results || {};
  let base = r.base ?? r.arith ?? r.evaluated ?? null;
  let disambiguator = r.disambiguator ?? r.disambig ?? r.stringmul ?? null;
  const baseline = r.baseline ?? r.benign ?? null;
  if (Array.isArray(r.probes)) {
    for (const p of r.probes) {
      if (!p) continue;
      const role = String(p.role ?? p._ssti_role ?? "").toLowerCase();
      const resp = p.response ?? p.raw_result ?? p;
      if (role.startsWith("disambig") || p.disambiguator === true) { if (disambiguator == null) disambiguator = resp; }
      else if (base == null) base = resp;
    }
  }
  if (base == null && Array.isArray(results)) base = results[0] ?? null;
  return { base, disambiguator, baseline };
}

/**
 * kind = ssti. CONFIRMED iff the BASE arithmetic payload evaluated (the result `49` is
 * present AND the literal `{{7*7}}` is ABSENT — server-side eval, impossible to reflect
 * literally) AND the DISAMBIGUATOR confirms (`{{7*'7'}}` → `7777777`, or a template-engine
 * error signature). REFUTED on literal reflection, or on a lone `49` whose disambiguator
 * did not evaluate (coincidental 49). Deterministic, high severity, NO LLM in the judge.
 *
 * results: { base, disambiguator, baseline? } | { probes:[{role,response}] } | [baseResp]
 *   each response: string | { status, body|body_preview } | executor envelope.
 * killTest (optional overrides): arith_payload/arith_evaluated/disambiguator_payload/
 *   disambiguator_evaluated — default to the shared catalog above.
 */
export function sstiOracle(killTest = {}, results = {}) {
  const arithPayload = String(killTest.arith_payload || SSTI_ARITH_PAYLOADS[0].payload);
  const arithEval = String(killTest.arith_evaluated || SSTI_ARITH_PAYLOADS[0].evaluated);
  const disPayload = String(killTest.disambiguator_payload || SSTI_DISAMBIGUATOR.payload);
  const disEval = String(killTest.disambiguator_evaluated || SSTI_DISAMBIGUATOR.evaluated);

  const { base, disambiguator } = pickSstiResponses(results);
  const baseBody = bodyOf(base);
  const disBody = bodyOf(disambiguator);
  const ev = {
    kind: "ssti",
    target_endpoint: killTest.target_endpoint || null,
    field: killTest.field || null,
    arith_payload: arithPayload,
    disambiguator_payload: disPayload,
  };

  if (base == null) {
    return { verdict: "inconclusive", evidence: { ...ev, reason: "no arithmetic (base) SSTI response to evaluate" }, fp_controlled: false };
  }

  // A literally reflected payload proves the engine did NOT evaluate → refuted.
  if (baseBody.includes(arithPayload)) {
    return { verdict: "refuted", evidence: { ...ev, literal_reflected: true, reason: "payload reflected LITERALLY — no server-side evaluation (reflection, not SSTI)" }, fp_controlled: true };
  }

  const baseEvaluated = baseBody.includes(arithEval);

  if (disambiguator == null) {
    // The disambiguator is MANDATORY to rule out a coincidental 49 (a bare 49 appears in
    // many benign bodies — ids, prices). Without it a confirm is not FP-controllable.
    return { verdict: "inconclusive", evidence: { ...ev, base_evaluated: baseEvaluated, reason: "no disambiguator ({{7*'7'}}) response — a lone 49 is not FP-controllable" }, fp_controlled: false };
  }

  const disMultiplied = disBody.includes(disEval) && !disBody.includes(disPayload);
  const disError = matchTemplateError(disBody);
  const disConfirmed = disMultiplied || Boolean(disError);

  if (baseEvaluated && disConfirmed) {
    return {
      verdict: "confirmed",
      evidence: {
        ...ev,
        base_evaluated: true,
        disambiguator_signal: disMultiplied ? `string-multiply → ${disEval}` : `template error: ${disError}`,
        engine_class: disMultiplied ? "jinja2/twig-class (string-multiply)" : "template-engine (error signature)",
        reason: "server EVALUATED {{7*7}}→49 (literal absent) AND the {{7*'7'}} disambiguator confirmed — server-side template injection",
      },
      fp_controlled: true,
    };
  }

  if (baseEvaluated && !disConfirmed) {
    return {
      verdict: "refuted",
      evidence: { ...ev, base_evaluated: true, reason: "arithmetic result present but the {{7*'7'}} disambiguator produced neither 7777777 nor a template error — coincidental 49, not SSTI" },
      fp_controlled: true,
    };
  }

  return { verdict: "refuted", evidence: { ...ev, base_evaluated: false, reason: "no evaluated arithmetic result in the response" }, fp_controlled: true };
}

// ════════════════════════════════════════════════════════════════════════════
// (10) verbose-error leakage — unambiguous signature, baseline-differenced
//      (H5 / RD-PLAN item 1). Feeds version→CVE chaining downstream.
// ════════════════════════════════════════════════════════════════════════════
/**
 * CLOSED catalog of UNAMBIGUOUS verbose-error signatures: stack-trace frames, framework
 * debug/error pages, raw SQL/DB errors, and internal filesystem paths. None of these can
 * appear in a well-behaved (benign) response, and the oracle additionally BASELINE-
 * DIFFERENCES every hit — a signature already present in the benign baseline is never a
 * finding. The pair (unambiguous corpus × baseline-difference) is what makes FP near-zero.
 */
export const ERROR_LEAKAGE_SIGNATURES = Object.freeze([
  // ── stack-trace frames ──
  { id: "js_stack_frame", re: /\bat\s+[\w$.<>\[\] ]+\s*\((?:[^\s()]*[\/\\])?[^\s()]+:\d+:\d+\)/ },
  { id: "js_anon_frame", re: /\bat\s+[\/\\][^\s()]+:\d+:\d+/ },
  { id: "node_modules", re: /node_modules[\/\\][\w.\-\/\\]+/ },
  { id: "py_traceback", re: /Traceback \(most recent call last\)/ },
  { id: "py_file_line", re: /File "[^"]+", line \d+/ },
  { id: "java_stack_frame", re: /\bat\s+[\w.$]+\([\w.$ ]*\.java:\d+\)/ },
  { id: "java_exception", re: /\b(?:java|javax|jakarta|org\.springframework|org\.hibernate)\.[\w.$]+(?:Exception|Error)\b/ },
  { id: "dotnet_stack_frame", re: /\bat\s+[\w.<>+]+\s+in\s+[A-Za-z]:\\[^:\n]+:line\s+\d+/ },
  { id: "php_stack", re: /Stack trace:\s*#0\s/ },
  { id: "ruby_stack_frame", re: /\.rb:\d+:in\s+[`']/ },
  // ── framework debug / error pages ──
  { id: "express_pre_stack", re: /<pre>[^<]*\bat\s+[\w$.]+[\s\S]{0,400}?<\/pre>/ },
  { id: "werkzeug_debugger", re: /Werkzeug Debugger|werkzeug\.exceptions\.\w+/ },
  { id: "rails_error", re: /(?:ActionController|ActiveRecord|ActionView)::[\w:]+/ },
  { id: "symfony_whoops", re: /Whoops\\[\w\\]+|Symfony\\Component\\[\w\\]+/ },
  { id: "django_debug", re: /You're seeing this error because you have DEBUG = True/ },
  // ── raw SQL / DB errors ──
  { id: "sequelize_error", re: /Sequelize\w*Error/ },
  { id: "sql_syntax_error", re: /(?:You have an error in your SQL syntax|near "[^"]*": syntax error|unterminated quoted string|unclosed quotation mark)/i },
  { id: "sqlstate", re: /SQLSTATE\[[0-9A-Z]+\]/ },
  { id: "sqlite_error", re: /SQLITE_ERROR|SQLITE_CONSTRAINT|no such column:/ },
  { id: "postgres_error", re: /(?:PG::\w+|invalid input syntax for (?:type )?\w+|column "[^"]+" does not exist)/ },
  { id: "mysql_error", re: /(?:for the right syntax to use near|com\.mysql\.jdbc|Warning: mysqli?_)/i },
  { id: "oracle_error", re: /ORA-\d{5}/ },
  { id: "mssql_error", re: /(?:Unclosed quotation mark after the character string|Incorrect syntax near)/i },
  { id: "mongo_error", re: /Mongo(?:Server)?Error|E11000 duplicate key/ },
  // ── internal filesystem paths (ambiguous ones require a file extension) ──
  { id: "unix_home_path", re: /\/home\/[\w.\-]+\/[\w.\-\/]*\.\w{1,6}\b/ },
  { id: "unix_www_path", re: /\/var\/www[\/\w.\-]*/ },
  { id: "unix_usr_path", re: /\/usr\/(?:local|lib|share|src)\/[\w.\-\/]+/ },
  { id: "unix_app_path", re: /\/(?:app|opt|srv)\/[\w.\-\/]*\.\w{1,6}\b/ },
  { id: "win_path", re: /[A-Za-z]:\\(?:Users|inetpub|wwwroot|Windows|Program Files|xampp|wamp)[\\\w.\- ]+/ },
]);

/** Scan a body for the closed verbose-error signature corpus. */
export function scanErrorSignatures(body) {
  const s = String(body || "");
  const out = [];
  for (const sig of ERROR_LEAKAGE_SIGNATURES) {
    const m = s.match(sig.re);
    if (m) out.push({ id: sig.id, sample: String(m[0]).slice(0, 120) });
  }
  return out;
}

function looksLikeResponseObj(x) {
  if (typeof x === "string") return true;
  if (!x || typeof x !== "object") return false;
  return x.status != null || x.body != null || x.body_preview != null || x.text != null || x.raw_result != null || x.response != null;
}

/** Pull the malformed-probe + benign-baseline responses out of the accepted shapes. */
function pickErrorLeakResponses(results) {
  const r = results || {};
  const baseline = r.baseline ?? r.benign ?? r.control ?? null;
  let probe = r.probe ?? r.malformed ?? null;
  if (probe == null && Array.isArray(results)) probe = results[0] ?? null;
  if (probe == null && (r.probe != null || r.malformed != null || r.baseline != null || r.benign != null || r.control != null)) probe = r.response ?? null;
  if (probe == null && looksLikeResponseObj(r) && !Array.isArray(results)) probe = r;
  return { probe, baseline };
}

/**
 * kind = error_leakage. CONFIRMED iff the malformed-input response contains ≥1 unambiguous
 * verbose-error signature (stack frame / framework error page / raw SQL-DB error / internal
 * filesystem path) that is NOT present in the benign baseline. REFUTED on a clean response,
 * or when the ONLY signatures also occur in the baseline (the app's normal verbose output,
 * not introduced by the probe). Near-zero FP; deterministic; NO LLM.
 *
 * results: { probe, baseline? } | [probeResp] | a bare probe response object.
 */
export function errorLeakageOracle(killTest = {}, results = {}) {
  const { probe, baseline } = pickErrorLeakResponses(results);
  const ev = { kind: "error_leakage", target_endpoint: killTest.target_endpoint || null, field: killTest.field || null };

  if (probe == null) {
    return { verdict: "inconclusive", evidence: { ...ev, reason: "no probe (malformed-input) response to scan" }, fp_controlled: false };
  }

  const probeBody = bodyOf(probe);
  const probeStatus = statusOf(probe);
  const inProbe = scanErrorSignatures(probeBody);
  const inBaseline = baseline != null ? new Set(scanErrorSignatures(bodyOf(baseline)).map((s) => s.id)) : new Set();

  // baseline-difference: only a signature ABSENT from the benign baseline is a leak.
  const netNew = inProbe.filter((s) => !inBaseline.has(s.id));
  const suppressed = inProbe.filter((s) => inBaseline.has(s.id));

  if (netNew.length > 0) {
    return {
      verdict: "confirmed",
      evidence: {
        ...ev,
        status: probeStatus,
        signatures: netNew.map((s) => ({ id: s.id, sample: s.sample })),
        baseline_differenced: baseline != null,
        reason: "unambiguous verbose-error signature present in the malformed-input response and ABSENT from the benign baseline",
      },
      fp_controlled: true,
    };
  }

  if (suppressed.length > 0) {
    return {
      verdict: "refuted",
      evidence: { ...ev, status: probeStatus, suppressed: suppressed.map((s) => s.id), reason: "error signature(s) also present in the benign baseline — app's normal verbose output, not introduced by the probe" },
      fp_controlled: true,
    };
  }

  return { verdict: "refuted", evidence: { ...ev, status: probeStatus, reason: "no verbose-error signature in the response (clean error handling)" }, fp_controlled: true };
}

// ════════════════════════════════════════════════════════════════════════════
// (11) JWT single-field forgery — differential auth-bypass (RD-PLAN 2026-07 item 4)
// ════════════════════════════════════════════════════════════════════════════
/**
 * kind = jwt_forgery. A FORGED single-field JWT tamper (alg:none / RS→HS key-confusion /
 * kid path-traversal·SQL·header-injection / jku·x5u / weak-secret HMAC re-sign /
 * exp·nbf·claim tamper) — a token a CORRECT server MUST reject (bad/none/foreign
 * signature) — is CONFIRMED as an auth bypass ONLY when it is ACCEPTED with the SAME
 * authorized success as a VALID baseline, BRACKETED by two controls:
 *
 *   (a) the VALID baseline (the original captured token) SUCCEEDS  — proving the endpoint
 *       is live AND auth-gated (there IS a protected resource / action to bypass), and
 *   (b) the INVALID-signature control (the original token with a CORRUPTED signature) is
 *       REJECTED — proving the server DOES verify signatures normally, so accepting the
 *       forgery is a REAL bypass, not a server that ignores auth entirely.
 *
 * CONFIRM requires all three: baseline accepted ∧ invalid control rejected ∧ forged
 * accepted. REFUTE when the forgery is rejected like the invalid control. INCONCLUSIVE
 * (never a FALSE confirm) when a control is missing/ambiguous, when the baseline itself
 * did not succeed (can't establish an auth-gated endpoint), or when the invalid control
 * ALSO succeeded (⇒ the endpoint is NOT auth-gated ⇒ there is no bypass to claim).
 * Deterministic, high severity, NO LLM in the judge (proposer ≠ judge).
 *
 * results: { valid_baseline, invalid_control, forged } (aliases accepted below).
 *   each response: string | { status, body|body_preview } | executor envelope.
 * killTest (optional): success_predicate (deterministic acceptance test; default 2xx),
 *   protected_marker (a byte that must appear in an authorized body), attack (label).
 */
export function jwtForgeryOracle(killTest = {}, results = {}) {
  const r = results || {};
  const baseline = r.valid_baseline ?? r.baseline ?? r.valid ?? r.control_valid ?? null;
  const invalid = r.invalid_control ?? r.invalid ?? r.corrupt_sig ?? r.bad_sig ?? r.control_invalid ?? null;
  const forged = r.forged ?? r.forgery ?? r.tampered ?? r.mutation ?? null;
  const ev = {
    kind: "jwt_forgery",
    target_endpoint: killTest.target_endpoint || null,
    field: killTest.field || null,
    attack: killTest.attack || null,
  };

  const predicate = killTest.success_predicate || killTest.violation_predicate;
  const marker = killTest.protected_marker != null ? String(killTest.protected_marker) : null;
  // Deterministic "authorized success" test. Default: a 2xx status (+ optional protected
  // marker in the body). A typed predicate overrides. Returns null when there is no
  // response to judge (distinguishes "missing" from "rejected").
  const accepts = (resp) => {
    if (resp == null) return null;
    const status = statusOf(resp);
    const body = bodyOf(resp);
    let ok;
    if (typeof predicate === "string" && predicate.trim()) {
      ok = evaluatePredicate(predicate, { status, body, body_preview: body });
    } else {
      ok = status >= 200 && status < 300;
    }
    if (ok && marker != null) ok = body.includes(marker);
    return ok;
  };

  // Nothing to judge.
  if (forged == null) {
    return { verdict: "inconclusive", evidence: { ...ev, reason: "no forged-token response to judge" }, fp_controlled: false };
  }

  // Control (a): the VALID baseline must SUCCEED — else we have no live, auth-gated
  // endpoint to bracket the forgery against (can't tell a bypass from a broken endpoint).
  const baseOk = accepts(baseline);
  if (baseline == null || baseOk !== true) {
    return {
      verdict: "inconclusive",
      evidence: { ...ev, baseline_present: baseline != null, baseline_accepted: baseOk, baseline_status: baseline != null ? statusOf(baseline) : null,
        reason: "valid baseline (original token) did not succeed — cannot establish a live, auth-gated endpoint to bracket the forgery" },
      fp_controlled: false,
    };
  }

  // Control (b): the INVALID-signature control must be REJECTED — else the server does not
  // verify signatures (or the endpoint is not auth-gated) and there is no bypass to claim.
  const invalidOk = accepts(invalid);
  if (invalid == null) {
    return {
      verdict: "inconclusive",
      evidence: { ...ev, reason: "no invalid-signature control — cannot prove the server checks signatures (a forgery accept would not be FP-controllable)" },
      fp_controlled: false,
    };
  }
  if (invalidOk === true) {
    // The corrupted-signature token ALSO succeeded ⇒ the server does not verify the
    // signature at all ⇒ the endpoint is NOT auth-gated on the token ⇒ NO forgery bypass to
    // claim. Honest inconclusive (never a false confirm).
    return {
      verdict: "inconclusive",
      evidence: { ...ev, invalid_control_accepted: true, invalid_status: statusOf(invalid),
        reason: "invalid-signature control ALSO accepted — endpoint not auth-gated on the token (no bypass to claim, not a false confirm)" },
      fp_controlled: true,
    };
  }

  // Both controls are sound (valid succeeds, invalid rejected). Now judge the forgery.
  const forgedOk = accepts(forged);
  const forgedStatus = statusOf(forged);
  if (forgedOk === true) {
    return {
      verdict: "confirmed",
      evidence: {
        ...ev,
        baseline_accepted: true,
        invalid_control_rejected: true,
        forged_accepted: true,
        baseline_status: statusOf(baseline),
        invalid_status: statusOf(invalid),
        forged_status: forgedStatus,
        reason: "FORGED token accepted with the same authorized success as the valid baseline, while the invalid-signature control was rejected — signature-verification bypass (auth forgery)",
      },
      fp_controlled: true,
    };
  }

  return {
    verdict: "refuted",
    evidence: {
      ...ev,
      forged_accepted: false,
      forged_status: forgedStatus,
      invalid_control_rejected: true,
      reason: "forged token rejected like the invalid-signature control — the server correctly rejects the tamper",
    },
    fp_controlled: true,
  };
}

// ── per-target FDR demotion of statistical confirmations (G17) ──────────────
/**
 * Apply the per-target Benjamini–Hochberg FDR cap (q=0.10) across a batch of
 * STATISTICAL (work_amplification / latency) verdicts on a target. A "confirmed"
 * verdict whose p-value does NOT clear its target's BH cap is DEMOTED to
 * `inconclusive` with `reason:"fdr_suppressed"`. Deterministic confirmations
 * (differential / OOB / repro / post-state) are not statistical and pass through.
 *
 * @param {{ id?, target?, target_endpoint?, kind?, verdict, evidence?, fp_controlled? }[]} verdicts
 * @param {number} [q=0.10]
 * @returns {{ verdicts:object[], perTarget:object }}
 */
export function applyTargetFdr(verdicts = [], q = DEFAULT_Q) {
  const ctrl = new TargetFdrController(q);
  const statistical = [];
  (verdicts || []).forEach((v, i) => {
    const isStat = v && (v.kind === "work_amplification" || v.metric === "latency_ms" || (v.evidence && v.evidence.metric === "latency_ms") || (v.evidence && v.evidence.p_value != null));
    if (!isStat) return;
    const p = (v.evidence && v.evidence.p_value != null) ? v.evidence.p_value : (v.p_value != null ? v.p_value : 1);
    const target = v.target ?? v.target_endpoint ?? (v.evidence && v.evidence.target_endpoint) ?? "?";
    const id = v.id != null ? String(v.id) : `t${i}`;
    ctrl.add(target, id, p);
    statistical.push({ i, id });
  });
  const { survivors, suppressed, perTarget } = ctrl.evaluate();
  const out = (verdicts || []).map((v, i) => {
    const s = statistical.find((x) => x.i === i);
    if (!s) return v;
    if (v.verdict === "confirmed" && suppressed.has(s.id)) {
      return {
        ...v,
        verdict: "inconclusive",
        fdr_suppressed: true,
        evidence: { ...(v.evidence || {}), reason: "fdr_suppressed", fdr_q: q },
      };
    }
    return v;
  });
  return { verdicts: out, perTarget, survivors: [...survivors], suppressed: [...suppressed] };
}

// ── deterministic dispatcher (proposer ≠ judge) ─────────────────────────────
/**
 * Route a kill_test to its Builder-B oracle by `kind`. Single-use and
 * off-wire-propagation are out of Builder B's scope (linear planner / OOB,
 * Phase 3) and return an honest inconclusive rather than a guess.
 */
export function runOracle(killTest = {}, results = {}) {
  switch (killTest.kind) {
    case "cross_actor_read":
      return crossActorReadOracle(killTest, results);
    case "work_amplification":
      return latencyOracle(killTest, results);
    case "client_only":
    case "range_violation":
      return affordanceProbeOracle(killTest, results);
    case "state_persistence":
      return postStatePersistenceOracle(killTest, results);
    case "single_use":
      // Resolvable now (G42/G29): a sound REPLAY-pair oracle. With insufficient
      // evidence (no consumed-use + replay pair) it is honestly inconclusive.
      return singleUseReplayOracle(killTest, results);
    case "conservation":
      return conservationBalanceOracle(killTest, results);
    case "repro_poc":
      return reproPocOracle(killTest, results);
    case "off_wire_propagation":
      // Resolvable via OOB (G53) when a listener + token are supplied; else inconclusive.
      return offWireOobOracle(killTest, results);
    case "ssti":
      // H5/item2: two-stage arithmetic differential ({{7*7}}→49 + {{7*'7'}}→7777777).
      return sstiOracle(killTest, results);
    case "error_leakage":
      // H5/item1: unambiguous verbose-error signature, baseline-differenced.
      return errorLeakageOracle(killTest, results);
    case "jwt_forgery":
      // RD-PLAN item4: single-field JWT forgery accepted where a correct server MUST
      // reject, bracketed by a valid-success + invalid-signature-rejected control pair.
      return jwtForgeryOracle(killTest, results);
    default:
      return {
        verdict: "inconclusive",
        evidence: { kind: killTest.kind || null, reason: "unknown kill_test kind" },
        fp_controlled: false,
      };
  }
}

export const PHASE2_ORACLE_KINDS = Object.freeze([
  "cross_actor_read", "work_amplification", "client_only", "range_violation",
  "state_persistence", "single_use", "conservation", "repro_poc", "off_wire_propagation",
  // H5 modern-injection differential oracles (RD-PLAN 2026-07 items 1+2).
  "ssti", "error_leakage",
  // JWT single-field forgery differential auth-bypass (RD-PLAN 2026-07 item 4).
  "jwt_forgery",
]);
