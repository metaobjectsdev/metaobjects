# Recipe: prove your `meta verify` gate can fail

A drift gate that has never gone red is not yet a gate. `meta verify` exits 0 on a tree it
checked, and also on a tree it checked nothing of: a config with `generators: []`, a wrong
working directory, a gate that was never wired into CI. So seed a deliberate break once, watch
the exit code flip to 1, and keep that test.

The runnable version, which this repository runs on every change, is
[`verify-gate-not-vacuous.test.ts`](../../server/typescript/packages/cli/test/integration/verify-gate-not-vacuous.test.ts).
It works in a throwaway project and asserts, in this order:

| Step | State | `meta verify` exit |
|---|---|---|
| 0 | `meta gen` ran, so the gate has generated files to compare | n/a |
| 1 | Clean tree | **0** |
| 2 | A field added to the metadata, `meta gen` not re-run | **1** (codegen gate) |
| 3 | Metadata restored | **0** (the failure was the break, not the harness) |
| 4 | A hand edit inside a generated file | **0** by default, **1** with `meta verify --codegen --forbid-hand-edits` |
| 5 | A generated file deleted | **1** |
| 6 | `meta gen` re-run | **0** |

Step 4 is deliberate: `meta gen` three-way-merges hand edits, so a hand-edited generated file
is a notice, not drift. If your policy is "generated code is never touched", gate on
`--forbid-hand-edits`. A second test in the same file pins why step 0 exists: a project with no
generators passes `meta verify` with exit 0 having checked nothing.

## The same check in a shell, for your own CI

```bash
set -u
meta gen                      || exit 1
meta verify                   || { echo "clean tree must pass"; exit 1; }

# Seed a break: change the model without regenerating.
cp metaobjects/meta.shop.json /tmp/meta.shop.json.bak
sed -i 's/"name": "email"/"name": "emailAddress"/' metaobjects/meta.shop.json

if meta verify; then echo "GATE IS VACUOUS: drifted tree passed"; status=1; else status=0; fi
cp /tmp/meta.shop.json.bak metaobjects/meta.shop.json
meta verify                   || status=1     # restored tree must pass again
exit $status
```

Adjust the file and the string to a field in your own model. Run it once when you wire the gate
(and after any change to `generators`, `sources` or the CI job), not on every build. Never leave
the break in the working tree: the restore is part of the check.

## As a bun:test in your repo

Copy the integration test above. It needs only the built `meta` binary on `PATH` (or
`node node_modules/@metaobjectsdev/cli/dist/bin/meta.js`), a project with at least one generator
declared, and a way to run `meta` with `cwd` set to a temp copy of the project. Replace its
`newShopProject` helper with a copy of your own fixture directory.

## What was checked

`bun test test/integration/verify-gate-not-vacuous.test.ts` in `server/typescript/packages/cli`
against the built CLI: both tests pass (steps 1-6 above, plus the empty-generators case). The
shell snippet is the same sequence with `sed` as the break and was not run separately.

See also: [pre-commit `meta verify`](precommit-meta-verify.md) for wiring the gate itself.
