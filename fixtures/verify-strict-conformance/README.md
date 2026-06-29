# verify-strict-conformance

Cross-port gate for **`verify` strict-by-default** (ADR-0023, issue #96).

`meta verify` (TS) and `metaobjects verify` (Python) load metadata **strict by
default**: an authored own `@attr` that no registered provider declares is
`ERR_UNKNOWN_ATTR`, and verify exits non-zero. This matches Java's Maven
`metaobjects:verify` goal, which already forces strict load
(`LoaderOptions.create(false, false, true)`). A `--lax` flag opts back into the
legacy open-attr load.

## Fixtures

Each case is a directory with:

- `input/` — a tiny metadata doc with one made-up `@attr` on a registered node.
- `expected.json` — the cross-port expectation:
  - `strict.exitNonZero` / `strict.errorCode` — bare `verify` (strict default)
    must fail with this loader error code.
  - `lax.exitZero` — `verify --lax` must succeed (the legacy open-attr load).

### `unregistered-attr`

A `field.string` carries `@madeUpAttr`, declared by no provider. Strict verify →
`ERR_UNKNOWN_ATTR` (exit non-zero); `verify --lax` → exit 0.

## Who asserts it

- **TypeScript** — `server/typescript/packages/cli/test/unit/verify-strict.test.ts`
  drives `verifyCommand` against the fixture metadata (default → exit 1; `--lax`
  → exit 0).
- **Python** — `server/python/tests/codegen/test_cli_verify_strict.py` drives the
  `metaobjects verify` CLI against the same fixture file.
- **Java** already enforces strict load via its Maven goal; the loader-level
  cross-port gate for `ERR_UNKNOWN_ATTR` lives in
  `fixtures/conformance/error-unknown-attr/` (all five ports).
