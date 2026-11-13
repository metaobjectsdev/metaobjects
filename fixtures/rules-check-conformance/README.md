# `verify` business-rules conformance corpus

Every port's `verify` runs the **rules gate** (ADR-0063): it reads the declared operations
(`api.operational` / `operation.*`) and lifecycles (`transition.action` under a `field.enum`)
of a loaded model and reports what loads clean but is almost certainly not what the author
meant. The loader already refuses a malformed operation or lifecycle; those errors are pinned
by `fixtures/conformance/` (`error-rules-*`), not here. This corpus is the shared source of
truth for the gate's codes, severities, node addresses, message text and summary counts.

TypeScript is the reference: `server/typescript/packages/cli/src/lib/rules-check.ts`. A port
reads that file before it writes its own checks, and its test suite runs this corpus.

It is a corpus of its own rather than a part of `fixtures/verify-conformance/`, which gates the
template (Mustache) drift check and has a different case shape. Its shape is the one
`fixtures/requirement-check-conformance/` uses, because the two gates do the same kind of
work: read a loaded model, report diagnostics.

## The checks

| Code | Severity | When |
|---|---|---|
| `WARN_LIFECYCLE_UNREACHABLE_STATE` | `verify.lifecycle.unreachable` (default `warn`; `off` skips it) | A member of a lifecycle's enum that no chain of transitions reaches from the initial state (`@default`). One diagnostic per lifecycle, listing the states in `@values` order. |
| `WARN_LIFECYCLE_INITIAL_TERMINAL` | `warn` | The initial state is terminal: no transition lists it in `@from` (a self-transition counts as leaving). |
| `WARN_TRANSITION_UNREACHABLE` | `verify.lifecycle.unreachable` | A transition whose every `@from` state is unreachable, so it can never be made. |
| `WARN_PERMISSION_DERIVED_NAME` | `rules.permissions.names`: `derive` (default) skips it, `advise` warns, `require` errors | An operation, or a transition that derives a command of its own, with no `@permission` and not `@public: true`. Which transitions derive a command is `rules.lifecycle.commands`: `unclaimed` (default) means those no declared command lists in `@transitions` for that target entity, `all` means every transition, `none` means none. |

The code keeps its `WARN_` prefix at every severity, as `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`
does under `--require-implementers`.

Order of evaluation, which is the order the reference reports in (not part of the contract):
each lifecycle once per DECLARING field, walking the root's entities in load order (abstract
included) — unreachable states, then initial-terminal, then each unreachable transition; then
the derived-command permission check per CONCRETE entity, over its effective transitions in
field order; then each operation of each `api.operational` in load order.

A lifecycle declared on an abstract base is checked once, at its declaring field. A derived
command exists per concrete entity, so the permission check names each concrete entity, with
the path `<package>::<Entity>.<field>.<transition>`.

The derived permission name is `<package>.<name>`: the package of the operation's API or of
the entity, a dot, then the operation or transition name. With no package it is the bare name.

## Fixture format

Each case is a directory:

- `input/` holds one or more metadata documents (`.yaml` or `.json`).
- `options.json` is optional. It holds the `rules` and `verify` blocks of
  `.metaobjects/config.json` exactly as a project writes them, and nothing else. A port runs
  them through its own config reader, so a key that reader does not know fails the case.
- `expected.json` holds `{ "diagnostics": [...], "summary": {...} | null }`.

A runner loads `input/` strict, in ascending file-name order, asserts no load errors, reads the
settings from `options.json` (each absent key at its default), runs the gate and compares.

`diagnostics` is an unordered multiset of `(severity, code, path, message)`. `path` is the
package-qualified dotted address of the node: `acme::purchasing::PurchaseRequest.status`.
`message` is compared exactly.

`summary` is `null` when the model declares no operation and no transition (then `verify`
prints nothing and lists no `rules` gate). Otherwise it holds `operations` (declared
operations across every `api.operational`), `lifecycles` (enum fields with at least one
transition, counted once per declaring field) and `transitions` (across those lifecycles).

`bun scripts/write-requirement-corpus-expected.ts rules` writes every `expected.json` from the
TypeScript reference. Review each written file by hand. A committed `expected.json` is never
edited to make a port pass.

## Cases

| Case | What it pins |
|---|---|
| `no-rules` | An entity with an enum and no transition, and no API: no diagnostics, and `summary` is `null`. |
| `clean-default-settings` | A full lifecycle (with a self-transition and a `@public` one), two commands and two queries, at the default settings: no diagnostics. |
| `lifecycle-create-any` | The same model with `rules.lifecycle.create: any`: the key is read and changes nothing `verify` reports. |
| `permission-names-advise` | `rules.permissions.names: advise`: warns on the unclaimed `submit` transition and on the two operations without `@permission`; not on a claimed transition, one with `@permission`, or anything `@public`. |
| `permission-names-require` | The same findings as errors under `require`. |
| `permission-names-commands-all` | `rules.lifecycle.commands: all`: the claimed transitions derive commands too, so they are reported as well. |
| `permission-names-commands-none` | `rules.lifecycle.commands: none`: no transition derives a command, so only operations are reported. |
| `unreachable-state` | Two unreachable states reported in one diagnostic, and the transition that starts only from them; a transition with one reachable `@from` state is not reported. |
| `unreachable-state-error` | The same findings as errors under `verify.lifecycle.unreachable: error`. |
| `unreachable-state-off` | Nothing under `verify.lifecycle.unreachable: off`. |
| `initial-terminal` | An initial state no transition leaves (with the unreachable checks off, to isolate it). |
| `inherited-lifecycle` | A lifecycle on an abstract base: its unreachable state is reported once at the base's field, and the derived-command permission check names each concrete entity. |
| `operations-only` | A model with operations and no lifecycle, under `require`: an operation without `@permission` is an error, and one with it is clean. |
