// Per-test timeout for every test file that type-checks generated output with the real
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
// that a compile which really hangs still fails in half a minute.
//
// Usage: each file calls `setDefaultTimeout(COMPILE_TEST_TIMEOUT_MS)` at its top level. It
// cannot be a side effect of importing this module: bun evaluates a module once per process,
// and `setDefaultTimeout` applies only to the file that calls it, so a side-effect import
// raises the timeout for the first importing file alone. Bun resets the default for each
// file, so files that do not call it keep the 5s hang detection.

/** Per-test timeout for type-checking tests: ~9x the slowest measured case. */
export const COMPILE_TEST_TIMEOUT_MS = 30_000;
