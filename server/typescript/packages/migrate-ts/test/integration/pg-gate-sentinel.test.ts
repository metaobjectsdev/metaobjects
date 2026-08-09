/**
 * Loud-skip guard for the real-Postgres suites in this package.
 *
 * Every one of them (`apply-pg`, `lifecycle-pg`, `postgres-roundtrip`,
 * `postgres-lenient-inet`, `pg-adopt-view-239`, …) `describe.skip`s when
 * `MIGRATE_TS_PG_URL` is unset. That is correct for a contributor with no local
 * Postgres — but in CI the same silence let the lane rot RED for eight consecutive
 * releases (v0.20.11 … v0.21.1) while every other lane stayed green, because the only
 * workflow that set the URL ran on the `v*` tag push, i.e. strictly AFTER the
 * irreversible four-registry publish.
 *
 * A lane that INTENDS to run these suites sets `MIGRATE_TS_PG_EXPECT=1` alongside the
 * URL. This test then fails loudly if the URL plumbing ever rots — a renamed variable,
 * a dropped sidecar, an unpublished port — instead of the suites quietly skipping and
 * the lane reporting success over zero real-engine coverage.
 *
 * A workflow-level `test -n "$MIGRATE_TS_PG_URL"` step cannot do this job: it checks the
 * workflow's environment, not what the test process actually reads, so a rename inside
 * the tests is exactly the drift it would miss. The URL-set-but-Postgres-broken arm needs
 * no sentinel — those suites already fail loudly on connect.
 */
import { describe, expect, test } from "bun:test";

describe("real-PG gate sentinel", () => {
  test("MIGRATE_TS_PG_URL is set when the lane declares MIGRATE_TS_PG_EXPECT=1", () => {
    if (process.env["MIGRATE_TS_PG_EXPECT"] === "1") {
      expect(process.env["MIGRATE_TS_PG_URL"]).toBeTruthy();
    }
  });
});
