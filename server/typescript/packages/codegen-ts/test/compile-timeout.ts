// Side-effect import for every test file that type-checks generated output with the real
// TypeScript compiler (`ts.createProgram`) or otherwise re-runs the whole generator suite.
//
// Why a timeout at all: bun's default is 5s. A compile test parses lib.d.ts, drizzle-orm and
// zod's declarations on every call, and that costs 0.5-3.3s on an idle machine (the slowest,
// codegen-compile-conformance, measured 2.7-3.3s per case; the full codegen-ts run measured
// 2.5 min for 3,293 tests). That is under 2x headroom against the default, so a loaded
// machine (a parallel lane, a gate run, another agent) pushes a correct test past 5s and it
// reports a timeout that says nothing about the code.
//
// 30s is ~9x the slowest measured case: loose enough that load cannot trip it, tight enough
// that a compile which really hangs still fails in half a minute. The default is restored when
// the importing file finishes, so other files keep bun's 5s hang detection.
//
// Usage: `import "./compile-timeout.js";` (relative to the test file) before the tests.

import { afterAll, setDefaultTimeout } from "bun:test";

/** Bun's own default per-test timeout, restored after a file that raised it. */
const BUN_DEFAULT_TIMEOUT_MS = 5_000;

/** Per-test timeout for type-checking tests: ~9x the slowest measured case. */
export const COMPILE_TEST_TIMEOUT_MS = 30_000;

setDefaultTimeout(COMPILE_TEST_TIMEOUT_MS);
afterAll(() => setDefaultTimeout(BUN_DEFAULT_TIMEOUT_MS));
