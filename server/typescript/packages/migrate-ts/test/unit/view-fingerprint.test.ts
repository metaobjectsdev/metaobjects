/**
 * view-fingerprint — the Postgres view comparator.
 *
 * Postgres does not store view SQL; it deparses it from the parse tree, so the
 * text we emitted can never be read back. The fingerprint sidesteps that entirely:
 * it is a hash of OUR generated body, stamped into the view's COMMENT and read back
 * from there. Both sides of the comparison therefore come from the same emitter, and
 * the deparser never enters the picture.
 */

import { describe, test, expect } from "bun:test";
import {
  FINGERPRINT_FORMAT_VERSION,
  normalizeForFingerprint,
  viewFingerprint,
  renderFingerprintMarker,
  parseFingerprintMarker,
} from "../../src/view-fingerprint.js";

describe("normalizeForFingerprint", () => {
  test("collapses whitespace runs, strips a trailing semicolon, and trims", () => {
    expect(normalizeForFingerprint("  SELECT   a,\n\n  b\n  FROM t ;  ")).toBe("SELECT a, b FROM t");
  });

  test("strips a leading CREATE [OR REPLACE] VIEW ... AS wrapper", () => {
    expect(normalizeForFingerprint(`CREATE OR REPLACE VIEW "v_x" AS SELECT a FROM t`)).toBe("SELECT a FROM t");
    expect(normalizeForFingerprint(`CREATE VIEW v_x AS SELECT a FROM t;`)).toBe("SELECT a FROM t");
  });

  test("does NOT lowercase — a case-only change in a string literal is real drift", () => {
    // normalizeViewSql (the SQLite comparator) lowercases to chase Postgres's
    // deparser. The fingerprint never chases the deparser, so it must not inherit
    // that blindness: an origin.aggregate @filter carries case-sensitive literals,
    // and `status = 'Active'` vs `status = 'active'` are different views.
    const a = viewFingerprint(`SELECT a FROM t WHERE s = 'Active'`);
    const b = viewFingerprint(`SELECT a FROM t WHERE s = 'active'`);
    expect(a).not.toBe(b);
  });
});

describe("viewFingerprint", () => {
  test("is stable across pure formatting churn — reindenting must not re-stamp every view", () => {
    const pretty = `SELECT
    p.id   AS "programId",
    COUNT(w.id) AS "weekCount"
  FROM programs p
  GROUP BY p.id`;
    const flat = `SELECT p.id AS "programId", COUNT(w.id) AS "weekCount" FROM programs p GROUP BY p.id`;
    expect(viewFingerprint(pretty)).toBe(viewFingerprint(flat));
  });

  test("changes when the body semantically changes", () => {
    expect(viewFingerprint("SELECT a FROM t")).not.toBe(viewFingerprint("SELECT a, b FROM t"));
  });

  test("is a 64-char lowercase sha256 hex digest", () => {
    expect(viewFingerprint("SELECT a FROM t")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("marker round-trip", () => {
  test("render → parse returns the same fingerprint", () => {
    const fp = viewFingerprint("SELECT a FROM t");
    const parsed = parseFingerprintMarker(renderFingerprintMarker(fp));
    expect(parsed).toEqual({ version: FINGERPRINT_FORMAT_VERSION, fingerprint: fp });
  });

  test("the marker is the TRAILING line, so human comment text above it survives", () => {
    const fp = viewFingerprint("SELECT a FROM t");
    const comment = `Program rollup, owned by the reporting team.\n${renderFingerprintMarker(fp)}`;
    expect(parseFingerprintMarker(comment)?.fingerprint).toBe(fp);
  });

  test("an UNKNOWN format version parses as managed-but-unknown, not as garbage", () => {
    // Self-healing: a view stamped by a newer toolchain is still OURS. We re-stamp it
    // (an allowed replace) rather than blocking it as unmanaged.
    const parsed = parseFingerprintMarker("metaobjects:v99:sha256:" + "a".repeat(64));
    expect(parsed?.version).toBe(99);
  });

  test("a comment with no marker, or a malformed one, parses as null (→ unmanaged → adopt gate)", () => {
    expect(parseFingerprintMarker(undefined)).toBeNull();
    expect(parseFingerprintMarker("")).toBeNull();
    expect(parseFingerprintMarker("just a human comment")).toBeNull();
    expect(parseFingerprintMarker("metaobjects:v1:sha256:tooshort")).toBeNull();
    expect(parseFingerprintMarker("metaobjects:v1:md5:" + "a".repeat(64))).toBeNull();
  });
});
