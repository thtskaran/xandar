/**
 * Unified Endpoint Identity System
 *
 * This module provides a centralized way to create, normalize, and compare endpoint identities.
 * It solves the critical bug where different parts of the pipeline used different normalization
 * methods, causing baseline lookups to fail and tasks to be incorrectly rejected.
 *
 * Key Design Decisions:
 * - Baseline keys: Strip query params and hash (for knowledge store lookups)
 * - Canonical keys: Sort query params (for deduplication)
 * - Display keys: Keep original URL (for human-readable output)
 *
 * Usage:
 *   import { makeEndpointIdentity } from "./utils/endpointIdentity.mjs";
 *   const eid = makeEndpointIdentity("POST", "https://site.com/api?foo=bar");
 *   const baselineKey = eid.toBaselineKey(); // For knowledge lookups
 *   const canonicalKey = eid.toCanonicalKey(); // For dedup signatures
 */

/**
 * Strips query parameters and hash from a URL, preserving the base path.
 * This is used for baseline endpoint identification in the knowledge store.
 *
 * @param {string} url - The URL to normalize
 * @returns {string} - URL without query params or hash
 */
function stripQueryAndHash(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Creates a canonical URL by sorting query parameters alphabetically.
 * This ensures that URLs with the same params in different orders are treated as identical.
 *
 * @param {string} url - The URL to canonicalize
 * @returns {string} - Canonical URL with sorted params
 */
function canonicalUrl(url) {
  const s = String(url || "");
  if (!s) return "";
  try {
    const u = new URL(s);
    const params = Array.from(u.searchParams.entries());
    params.sort((a, b) => {
      const aStr = a[0] + "=" + a[1];
      const bStr = b[0] + "=" + b[1];
      return aStr.localeCompare(bStr);
    });
    u.search = "";
    for (const [k, v] of params) {
      u.searchParams.append(k, v);
    }
    u.hash = "";
    return u.toString();
  } catch {
    return s;
  }
}

/**
 * Endpoint Identity Class
 *
 * Represents a normalized endpoint with multiple key formats for different use cases.
 * This ensures consistency across the entire pipeline.
 */
export class EndpointIdentity {
  constructor({ method, url }) {
    if (!url) {
      throw new Error("EndpointIdentity requires a valid URL");
    }

    const u = new URL(url);

    // Core properties
    this.method = String(method || "GET").toUpperCase();
    this.scheme = u.protocol.replace(":", "");
    this.host = u.hostname.toLowerCase();
    this.port = u.port || (u.protocol === "https:" ? "443" : "80");
    this.path = u.pathname;
    this.rawUrl = url;

    // Normalized URL (baseline for knowledge store)
    this.normalizedUrl = stripQueryAndHash(url);

    // Canonical URL (for deduplication)
    this.canonicalUrl = canonicalUrl(url);

    // Baseline key: METHOD + normalized URL (no query/hash)
    // Used for: knowledge store lookups, baseline body size lookups
    this.baselineKey = `${this.method} ${this.normalizedUrl}`;

    // Query parameters (sorted for stability)
    // Sort by the same composite "key=value" key used in canonicalUrl() so the
    // two code paths can never disagree on ordering.
    this.queryParams = Array.from(u.searchParams.entries())
      .sort((a, b) => {
        const aStr = a[0] + "=" + a[1];
        const bStr = b[0] + "=" + b[1];
        return aStr.localeCompare(bStr);
      });

    this.hasQueryParams = this.queryParams.length > 0;
  }

  /**
   * Returns the baseline key used for knowledge store lookups.
   * This key has query params and hash stripped.
   *
   * CRITICAL: This must be used in policyGate.mjs for baseline lookups
   *
   * @returns {string} - e.g., "POST https://site.com/api/upload"
   */
  toBaselineKey() {
    return this.baselineKey;
  }

  /**
   * Returns a display-friendly string with the original URL.
   * Used for logging and human-readable output.
   *
   * @returns {string} - e.g., "POST https://site.com/api/upload?type=avatar"
   */
  toDisplayString() {
    return `${this.method} ${this.rawUrl}`;
  }

  /**
   * Returns a canonical key with sorted query parameters.
   * Used for deduplication signatures.
   *
   * @returns {string} - e.g., "POST https://site.com/api/data?a=1&b=2"
   */
  toCanonicalKey() {
    return `${this.method} ${this.canonicalUrl}`;
  }

  /**
   * Returns just the canonical URL (without method prefix).
   * Used in taskSig.mjs for signature generation.
   *
   * @returns {string} - e.g., "https://site.com/api/data?a=1&b=2"
   */
  toCanonicalUrl() {
    return this.canonicalUrl;
  }

  /**
   * Checks if this endpoint matches a given host.
   * Supports both exact match and subdomain match.
   *
   * @param {string} host - The host to check against
   * @returns {boolean} - True if matches
   */
  matchesHost(host) {
    const h = String(host).toLowerCase();
    if (!h) return false;
    return this.host === h || this.host.endsWith("." + h);
  }

  /**
   * Self-validation check.
   * Ensures the endpoint identity is consistent and valid.
   *
   * @returns {{valid: boolean, errors: string[]}}
   */
  validate() {
    const errors = [];

    if (!this.method) {
      errors.push("Method is empty");
    }

    if (!this.host) {
      errors.push("Host is empty");
    }

    if (!this.path) {
      errors.push("Path is empty");
    }

    // Ensure baseline key is actually normalized
    if (this.baselineKey.includes("?") || this.baselineKey.includes("#")) {
      errors.push("Baseline key should not contain query params or hash");
    }

    // Ensure method is uppercase
    if (this.method !== this.method.toUpperCase()) {
      errors.push("Method should be uppercase");
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Returns a debug representation of this endpoint identity.
   *
   * @returns {object}
   */
  toDebugObject() {
    return {
      method: this.method,
      host: this.host,
      path: this.path,
      rawUrl: this.rawUrl,
      normalizedUrl: this.normalizedUrl,
      canonicalUrl: this.canonicalUrl,
      baselineKey: this.baselineKey,
      hasQueryParams: this.hasQueryParams,
      queryParams: this.queryParams
    };
  }
}

/**
 * Factory function to create an EndpointIdentity.
 * Handles errors gracefully and returns a null-object pattern on failure.
 *
 * USE THIS EVERYWHERE instead of manually creating endpoint keys.
 *
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} url - Full URL
 * @returns {EndpointIdentity} - Endpoint identity object
 */
export function makeEndpointIdentity(method, url) {
  try {
    const eid = new EndpointIdentity({ method, url });

    // Self-correction: validate the created identity
    const validation = eid.validate();
    if (!validation.valid) {
      console.warn(`[EndpointIdentity] Validation warnings for ${method} ${url}:`, validation.errors);
    }

    return eid;
  } catch (e) {
    // Return a null-object pattern that won't crash the system
    // Silenced — relative paths from JSLuice cause this frequently and it's handled gracefully

    const safeMethod = String(method || "GET").toUpperCase();
    const safeUrl = String(url || "");
    const invalidKey = `INVALID ${safeUrl}`;

    return {
      method: safeMethod,
      host: "",
      path: "",
      rawUrl: safeUrl,
      normalizedUrl: safeUrl,
      canonicalUrl: safeUrl,
      baselineKey: invalidKey,
      hasQueryParams: false,
      queryParams: [],
      toBaselineKey: () => invalidKey,
      toDisplayString: () => `${safeMethod} ${safeUrl}`,
      toCanonicalKey: () => invalidKey,
      toCanonicalUrl: () => safeUrl,
      matchesHost: () => false,
      validate: () => ({ valid: false, errors: ["Invalid URL"] }),
      toDebugObject: () => ({
        method: safeMethod,
        rawUrl: safeUrl,
        error: "Invalid endpoint identity"
      })
    };
  }
}

/**
 * Helper: Parse an endpoint key string back into components.
 * Key format: "METHOD https://host/path"
 *
 * @param {string} key - Endpoint key string
 * @returns {{method: string, url: string} | null}
 */
export function parseEndpointKey(key) {
  const s = String(key || "");
  const match = s.match(/^([A-Z]+)\s+(https?:\/\/.+)$/i);
  if (!match) return null;

  return {
    method: match[1].toUpperCase(),
    url: match[2]
  };
}

/**
 * Helper: Check if two endpoint identities refer to the same baseline endpoint.
 *
 * @param {EndpointIdentity} eid1
 * @param {EndpointIdentity} eid2
 * @returns {boolean}
 */
export function isSameBaselineEndpoint(eid1, eid2) {
  if (!eid1 || !eid2) return false;
  return eid1.toBaselineKey() === eid2.toBaselineKey();
}

/**
 * Self-test function to verify the module works correctly.
 * Run this during development to catch regressions.
 *
 * @returns {{passed: boolean, tests: object[]}}
 */
export function runSelfTest() {
  const tests = [];

  // Test 1: Query param normalization
  try {
    const e1 = makeEndpointIdentity("POST", "https://site.com/api/upload?type=avatar");
    const e2 = makeEndpointIdentity("POST", "https://site.com/api/upload");
    const sameBaseline = e1.toBaselineKey() === e2.toBaselineKey();
    tests.push({
      name: "Query param normalization",
      passed: sameBaseline,
      expected: "POST https://site.com/api/upload",
      actual: e1.toBaselineKey(),
      message: sameBaseline ? "✓ Baseline keys match correctly" : "✗ Baseline keys should match"
    });
  } catch (e) {
    tests.push({ name: "Query param normalization", passed: false, error: e.message });
  }

  // Test 2: Canonical key with sorted params
  try {
    const e3 = makeEndpointIdentity("GET", "https://api.com/data?b=2&a=1");
    const e4 = makeEndpointIdentity("GET", "https://api.com/data?a=1&b=2");
    const sameCanonical = e3.toCanonicalKey() === e4.toCanonicalKey();
    tests.push({
      name: "Canonical key param sorting",
      passed: sameCanonical,
      expected: "GET https://api.com/data?a=1&b=2",
      actual: e3.toCanonicalKey(),
      message: sameCanonical ? "✓ Canonical keys match correctly" : "✗ Canonical keys should match"
    });
  } catch (e) {
    tests.push({ name: "Canonical key param sorting", passed: false, error: e.message });
  }

  // Test 3: Host matching
  try {
    const e5 = makeEndpointIdentity("GET", "https://secure.example.com/api/users");
    const matchesParent = e5.matchesHost("example.com");
    const matchesExact = e5.matchesHost("secure.example.com");
    const matchesOther = e5.matchesHost("other.com");
    const hostMatchCorrect = matchesParent && matchesExact && !matchesOther;
    tests.push({
      name: "Host matching",
      passed: hostMatchCorrect,
      message: hostMatchCorrect ? "✓ Host matching works correctly" : "✗ Host matching failed",
      details: { matchesParent, matchesExact, matchesOther }
    });
  } catch (e) {
    tests.push({ name: "Host matching", passed: false, error: e.message });
  }

  // Test 4: Method normalization
  try {
    const e6 = makeEndpointIdentity("post", "https://site.com/api");
    const methodUppercase = e6.method === "POST";
    tests.push({
      name: "Method normalization",
      passed: methodUppercase,
      expected: "POST",
      actual: e6.method,
      message: methodUppercase ? "✓ Method is uppercase" : "✗ Method should be uppercase"
    });
  } catch (e) {
    tests.push({ name: "Method normalization", passed: false, error: e.message });
  }

  // Test 5: Invalid URL handling
  try {
    const e7 = makeEndpointIdentity("GET", "not-a-valid-url");
    const handlesInvalid = e7.toBaselineKey().startsWith("INVALID");
    tests.push({
      name: "Invalid URL handling",
      passed: handlesInvalid,
      message: handlesInvalid ? "✓ Invalid URLs handled gracefully" : "✗ Should handle invalid URLs",
      actual: e7.toBaselineKey()
    });
  } catch (e) {
    tests.push({ name: "Invalid URL handling", passed: false, error: e.message });
  }

  // Test 6: Hash stripping
  try {
    const e8 = makeEndpointIdentity("GET", "https://site.com/page#section");
    const e9 = makeEndpointIdentity("GET", "https://site.com/page");
    const hashStripped = e8.toBaselineKey() === e9.toBaselineKey();
    tests.push({
      name: "Hash stripping",
      passed: hashStripped,
      expected: "GET https://site.com/page",
      actual: e8.toBaselineKey(),
      message: hashStripped ? "✓ Hashes stripped correctly" : "✗ Hashes should be stripped"
    });
  } catch (e) {
    tests.push({ name: "Hash stripping", passed: false, error: e.message });
  }

  const passed = tests.every(t => t.passed);
  return { passed, tests };
}
