/**
 * Drift guard between the CLI's authoritative `--allow` token list
 * (`ALLOW_TOKENS`, `lib/args.ts` — the list that actually validates
 * `--allow <csv>`) and `sdk`'s `AllowTokenEnum` (`config.ts` — the list that
 * validates the STATIC `migrate.allow` array in `.metaobjects/config.json`).
 *
 * These silently drifted before this test existed: sdk's enum had only 6 of
 * the 11 real tokens, missing `drop-check`, `drop-view`, `drop-view-cascade`,
 * `adopt-view` and `drop-identity-default`. A user who set any of those five
 * in `.metaobjects/config.json`'s `migrate.allow` got a schema rejection for
 * a flag the CLI itself accepted fine on the command line — `adopt-view` had
 * shipped since 0.20.4 and was affected the whole time.
 *
 * Import BOTH sides rather than hardcoding a third "expected" list here — a
 * hardcoded list would just be a fourth copy that can itself drift.
 *
 * Package-dependency direction: `cli` depends on `sdk` (`workspace:*`), not
 * the other way around, so this test can only live in `cli` — `sdk` cannot
 * import from `cli` without introducing a cycle. `sdk`'s `AllowTokenEnum`
 * itself carries a doc comment pointing back at this test as the drift guard,
 * since `sdk` has no test that can perform the comparison from its own side.
 */
import { test, expect, describe } from "bun:test";
import { ALLOW_TOKENS } from "../../src/lib/args.js";
import { AllowTokenEnum } from "@metaobjectsdev/sdk";

describe("--allow token lists stay pinned across packages", () => {
  test("sdk's AllowTokenEnum and the CLI's ALLOW_TOKENS validate the exact same token set", () => {
    const cliTokens = new Set<string>(ALLOW_TOKENS);
    const sdkTokens = new Set<string>(AllowTokenEnum.options);

    const missingFromSdk = [...cliTokens].filter((t) => !sdkTokens.has(t));
    const missingFromCli = [...sdkTokens].filter((t) => !cliTokens.has(t));

    expect(missingFromSdk).toEqual([]);
    expect(missingFromCli).toEqual([]);
    expect(sdkTokens.size).toBe(cliTokens.size);
  });
});
