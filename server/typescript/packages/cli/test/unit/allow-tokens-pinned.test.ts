/**
 * Drift guard across the three token-bearing structures behind `--allow`:
 *
 * - `ALLOW_TOKENS` (`lib/args.ts`) — the CLI's authoritative list; what
 *   actually VALIDATES `--allow <csv>`.
 * - `AllowTokenEnum` (`sdk`'s `config.ts`) — validates the STATIC
 *   `migrate.allow` array in `.metaobjects/config.json`.
 * - `ALLOW_TOKEN_MAP` (`lib/allow.ts`) — what actually GRANTS the permission,
 *   translating a validated token into the `AllowOptions` field `diff()`
 *   reads.
 *
 * `ALLOW_TOKENS` and `AllowTokenEnum` silently drifted before this test
 * existed: sdk's enum had only 6 of the 11 real tokens, missing
 * `drop-check`, `drop-view`, `drop-view-cascade`, `adopt-view` and
 * `drop-identity-default`. A user who set any of those five in
 * `.metaobjects/config.json`'s `migrate.allow` got a schema rejection for a
 * flag the CLI itself accepted fine on the command line — `adopt-view` had
 * shipped since 0.20.4 and was affected the whole time.
 *
 * `ALLOW_TOKEN_MAP` is a distinct, worse failure mode if it drifts from
 * `ALLOW_TOKENS`: a token present in `ALLOW_TOKENS` (and `AllowTokenEnum`)
 * but missing from the map passes validation cleanly and then
 * `tokensToAllowOptions` silently grants NOTHING for it — the user believes
 * `--allow <token>` authorized a destructive drop; it didn't, and the diff
 * blocks it anyway with no indication the flag was ever a no-op. That is a
 * silent-failure mode on exactly the path this whole feature exists to
 * protect.
 *
 * Import ALL of these rather than hardcoding a fourth "expected" list here —
 * a hardcoded list would just be a fifth copy that can itself drift.
 *
 * Package-dependency direction: `cli` depends on `sdk` (`workspace:*`), not
 * the other way around, so this test can only live in `cli` — `sdk` cannot
 * import from `cli` without introducing a cycle. `sdk`'s `AllowTokenEnum`
 * itself carries a doc comment pointing back at this test as the drift guard,
 * since `sdk` has no test that can perform the comparison from its own side.
 */
import { test, expect, describe } from "bun:test";
import { ALLOW_TOKENS } from "../../src/lib/args.js";
import { ALLOW_TOKEN_MAP } from "../../src/lib/allow.js";
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

  test("ALLOW_TOKEN_MAP grants a permission for every validated token, and nothing extra", () => {
    const cliTokens = new Set<string>(ALLOW_TOKENS);
    const mapKeys = new Set<string>(Object.keys(ALLOW_TOKEN_MAP));

    const validatedButNotGranted = [...cliTokens].filter((t) => !mapKeys.has(t));
    const grantedButNotValidated = [...mapKeys].filter((t) => !cliTokens.has(t));

    expect(validatedButNotGranted).toEqual([]);
    expect(grantedButNotValidated).toEqual([]);
    expect(mapKeys.size).toBe(cliTokens.size);
  });

  test("ALLOW_TOKEN_MAP's AllowOptions fields are unique — no two tokens grant the same permission", () => {
    const fields = Object.values(ALLOW_TOKEN_MAP);
    const uniqueFields = new Set(fields);
    expect(uniqueFields.size).toBe(fields.length);
  });
});
