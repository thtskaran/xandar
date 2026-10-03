/**
 * hunter-v2 — per-target Benjamini–Hochberg FDR control (HUNTER §R-GATE7/§8 L591-593).
 *
 * A single target fires DOZENS-to-HUNDREDS of statistical tests (latency / fan-out /
 * DoS sweeps). Per-test α alone reports ~`α·N` false DoS bugs per target. The freeze
 * list mandates a **per-target Benjamini–Hochberg FDR cap `q=0.10`** ACROSS all such
 * tests on a target, so the reported set's expected false-discovery proportion ≤ q.
 *
 * This module is pure + deterministic:
 *   - `pValueFromSpearman(rho, n)`  → a one-sided p-value (positive monotone = work
 *      amplification) via the Student-t approximation of the rank correlation;
 *   - `benjaminiHochberg(pvals, q)` → the standard step-up procedure → which tests
 *      survive the FDR cap;
 *   - `TargetFdrController`         → accumulates (target, test) p-values and demotes
 *      any "confirmed" statistical verdict that does NOT clear its target's BH cap.
 *
 * Confirmations from DETERMINISTIC oracles (cross-actor differential, OOB, repro,
 * post-state read) are NOT statistical and are NOT subject to the FDR cap.
 */

export const DEFAULT_Q = 0.10;

// ── Student-t upper-tail (pure; regularized incomplete beta, Numerical Recipes) ──

function gammln(xx) {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let x = xx, y = xx;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += cof[j] / y; }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
  const FPMIN = 1e-300, EPS = 3e-12, MAXIT = 200;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Upper-tail Student-t survival P(T_df ≥ t). */
export function studentTUpperTail(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  const x = df / (df + t * t);
  const twoSided = betai(df / 2, 0.5, x); // P(|T| ≥ |t|)
  return t >= 0 ? twoSided / 2 : 1 - twoSided / 2;
}

/**
 * One-sided p-value for a POSITIVE Spearman rank correlation (work-amplification
 * direction). n = number of (x, metric) points used in the fit. Conservative: with
 * < 3 points there is no test → p = 1 (never significant).
 */
export function pValueFromSpearman(rho, n) {
  const r = Number(rho);
  const m = Number(n);
  if (!Number.isFinite(r) || !Number.isFinite(m) || m < 3) return 1;
  if (r <= 0) return 1;          // wrong direction → not a one-sided positive signal
  if (r >= 1) return 0;          // perfect monotone
  const df = m - 2;
  const t = r * Math.sqrt(df / (1 - r * r));
  const p = studentTUpperTail(t, df);
  return Math.min(1, Math.max(0, p));
}

// ── Benjamini–Hochberg step-up ───────────────────────────────────────────────

/**
 * Benjamini–Hochberg FDR procedure at level q.
 * @param {number[]} pvals
 * @param {number} [q=0.10]
 * @returns {{ survive:boolean[], threshold:number, k:number }}
 *   survive[i] — does test i clear the FDR cap (its null is rejected = significant)?
 *   threshold  — the largest p-value still accepted (0 if none).
 *   k          — the BH rank cutoff (number of rejections).
 */
export function benjaminiHochberg(pvals, q = DEFAULT_Q) {
  const m = pvals.length;
  const survive = new Array(m).fill(false);
  if (m === 0) return { survive, threshold: 0, k: 0 };
  const order = pvals.map((p, i) => ({ p: Number.isFinite(p) ? p : 1, i })).sort((a, b) => a.p - b.p);
  let kmax = -1;
  for (let rank = 1; rank <= m; rank++) {
    const crit = (rank / m) * q;
    if (order[rank - 1].p <= crit) kmax = rank; // largest rank meeting the BH line
  }
  if (kmax < 0) return { survive, threshold: 0, k: 0 };
  for (let rank = 1; rank <= kmax; rank++) survive[order[rank - 1].i] = true;
  return { survive, threshold: order[kmax - 1].p, k: kmax };
}

// ── per-target controller (demote confirmations that fail the cap) ───────────

export class TargetFdrController {
  /** @param {number} [q=0.10] the frozen per-target FDR cap. */
  constructor(q = DEFAULT_Q) {
    this.q = Number(q) > 0 ? Number(q) : DEFAULT_Q;
    /** @type {Map<string,{id:string,p:number}[]>} target → statistical tests */
    this.byTarget = new Map();
  }

  /** Record one statistical test's p-value on a target. */
  add(target, testId, pValue) {
    const t = String(target || "?");
    const arr = this.byTarget.get(t) || [];
    arr.push({ id: String(testId), p: Number.isFinite(pValue) ? pValue : 1 });
    this.byTarget.set(t, arr);
    return this;
  }

  /**
   * Apply BH per target; return the set of test ids that SURVIVE the FDR cap (i.e.
   * may stay "confirmed"). All others are demoted to "fdr_suppressed".
   * @returns {{ survivors:Set<string>, suppressed:Set<string>, perTarget:object }}
   */
  evaluate() {
    const survivors = new Set();
    const suppressed = new Set();
    const perTarget = {};
    for (const [target, tests] of this.byTarget.entries()) {
      const { survive, threshold, k } = benjaminiHochberg(tests.map((t) => t.p), this.q);
      perTarget[target] = { n: tests.length, k, threshold, q: this.q };
      tests.forEach((t, i) => (survive[i] ? survivors : suppressed).add(t.id));
    }
    return { survivors, suppressed, perTarget };
  }
}
