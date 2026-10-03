/**
 * Expectation Oracle (hunter-v2 Phase 0).
 *
 * Tasks carry an `expected_response` predicate string describing the vuln signal
 * (e.g. "status != 401 && body contains user_data", "status < 400"). This module is
 * a SMALL, SAFE, deterministic evaluator for a bounded grammar — no eval/Function,
 * the parser is hand-written.
 *
 * Grammar (case-insensitive keywords):
 *   predicate := orGroup ( "||" orGroup )*
 *   orGroup   := term ( "&&" term )*
 *   term      := "status" <op> <number>            // op ∈ == = != < <= > >=
 *              | "body" "contains" <value>
 *              | "body" "not" "contains" <value>
 *   <value>   := optionally-quoted string
 *
 * Semantics: standard precedence — `&&` binds tighter than `||` (OR of ANDs).
 *
 * Robustness contract: if ANY term fails to parse, the WHOLE predicate is treated
 * as malformed and evaluation returns false (a safe no-op). We only ever fire on a
 * fully-parsed, clearly-satisfied predicate. Nothing here throws.
 */

const COMPARATORS = {
  "==": (a, b) => a === b,
  "=":  (a, b) => a === b,
  "!=": (a, b) => a !== b,
  "<":  (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">":  (a, b) => a > b,
  ">=": (a, b) => a >= b,
};

function stripQuotes(s) {
  const t = String(s).trim();
  if (t.length >= 2 &&
      ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse a single comparison/contains term → node {eval} or null if unparseable. */
function parseTerm(raw) {
  const term = String(raw || "").trim();
  if (!term) return null;

  // status <op> N   (N is a 1-3 digit HTTP status)
  let m = term.match(/^status\s*(==|!=|>=|<=|=|<|>)\s*(\d{1,3})$/i);
  if (m) {
    const op = m[1];
    const n = Number(m[2]);
    const cmp = COMPARATORS[op];
    if (!cmp) return null;
    return { kind: "status", op, n, eval: (ctx) => cmp(ctx.status, n) };
  }

  // body not contains X
  m = term.match(/^body\s+not\s+contains\s+(.+)$/i);
  if (m) {
    const needle = stripQuotes(m[1]).toLowerCase();
    if (!needle) return null;
    return { kind: "body_not_contains", needle, eval: (ctx) => !ctx.body.includes(needle) };
  }

  // body contains X
  m = term.match(/^body\s+contains\s+(.+)$/i);
  if (m) {
    const needle = stripQuotes(m[1]).toLowerCase();
    if (!needle) return null;
    return { kind: "body_contains", needle, eval: (ctx) => ctx.body.includes(needle) };
  }

  return null;
}

/**
 * Parse a full predicate string.
 * @returns {{ eval: (ctx) => boolean }|null} null if malformed.
 */
export function parsePredicate(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;

  const groups = [];
  for (const orPart of s.split("||")) {
    const terms = [];
    for (const andPart of orPart.split("&&")) {
      const node = parseTerm(andPart);
      if (!node) return null; // any unparseable term voids the whole predicate
      terms.push(node);
    }
    if (terms.length === 0) return null;
    groups.push(terms);
  }
  if (groups.length === 0) return null;

  return {
    eval(ctx) {
      // OR over groups, AND within each group.
      return groups.some((g) => g.every((t) => t.eval(ctx)));
    },
  };
}

/** Normalize a task-result envelope into the evaluation context. */
function normalizeResult(result) {
  const r = result || {};
  const rawStatus = r.status ?? r.actor_a?.status ?? r.response?.status ?? 0;
  const status = Number(rawStatus) || 0;
  const bodyRaw = r.body_preview ?? r.body ?? r.response?.body ?? r.actor_a?.body ?? "";
  return { status, body: String(bodyRaw).toLowerCase() };
}

/**
 * Evaluate a predicate against a result. Returns true ONLY when the predicate
 * parses cleanly AND is satisfied by the actual response. Never throws.
 * @returns {boolean}
 */
export function evaluatePredicate(predicate, result) {
  const parsed = parsePredicate(predicate);
  if (!parsed) return false;
  try {
    return parsed.eval(normalizeResult(result)) === true;
  } catch {
    return false;
  }
}

function sameValue(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (typeof actual === "number" && typeof expected === "string" && expected.trim() !== "") {
    return Number(expected) === actual;
  }
  if (typeof expected === "number" && typeof actual === "string" && actual.trim() !== "") {
    return Number(actual) === expected;
  }
  return false;
}

function findFieldValue(node, field, expected) {
  if (node == null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((item) => findFieldValue(item, field, expected));
  for (const [key, value] of Object.entries(node)) {
    if (key === field && sameValue(value, expected)) return true;
    if (findFieldValue(value, field, expected)) return true;
  }
  return false;
}

/** Require an exact JSON field/value echo; substring matches such as 0 in 200 are unsafe. */
export function responseEchoesFieldValue(body, field, expected) {
  if (!field || expected === undefined || expected === null) return false;
  try {
    return findFieldValue(JSON.parse(String(body || "")), String(field), expected);
  } catch {
    return false;
  }
}
