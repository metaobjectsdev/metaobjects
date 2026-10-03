# `meta fmt` conformance corpus (#304)

Every port's `fmt` command must format a metadata **file** identically —
same canonical bytes, same decision about whether a file can be formatted at
all. This corpus is the shared source of truth, run by each port's own test
suite, the same way `fixtures/conformance/` gates the loader and
`fixtures/render-conformance/` gates the render engine.

## Scope: one file, standalone

`fmt` formats each file **on its own** — own-mode, declared-here layer only
(ADR-0039). It never merges a file with its siblings: an `extends` onto a
base declared in another file is preserved as the raw ref string (never
resolved, never an error here — resolving it is the full project loader's
job, not fmt's), and a file declaring `overlay: true` ANYWHERE in its tree is
reported as a skip, not guessed at — **whether or not a same-file base
exists to merge into.** A formatter never changes structure: a plain
declaration and a same-`(type, name)` `overlay: true` redeclaration in the
SAME file does have a local base, and the ordinary loader would merge them —
but merging silently drops the overlay marker from the output, which is a
structural change `fmt` must never make. So this is checked directly against
the raw document before anything else runs, not inferred from whether
resolution happens to fail.

This corpus therefore exercises exactly that single-file contract. Loading a
whole PROJECT (resolving sources, running the whole-project safety check
before a file is rewritten) is CLI-level orchestration, specific to each
port's command surface, and is not what this corpus gates — each port's own
integration tests cover that.

## Fixture format

```
<fixture-name>/
├── input.json           # required — one metadata file's own raw content
├── expected.json         # happy path: the canonical text fmt must produce
└── expected-skip.json    # OR: fmt must refuse to format this file standalone
```

**Exactly one** of `expected.json` or `expected-skip.json` is present:

- `expected.json` — formatting `input.json` standalone succeeds. The file's
  canonical output (2-space indent, canonical key order, `@`-attrs
  alphabetized, a scalar `@fields` normalized to its array form, the
  FR-016/ADR-0018 `source.rdb` physical-name rewrite applied, trailing
  newline) MUST deep-equal — and for JSON-emitting ports, byte-equal —
  this file.
- `expected-skip.json` — `{ "reason": "overlay" | "error" }`. `fmt` must
  refuse to format `input.json` standalone and classify WHY:
  - `"overlay"` — the file declares (or contains, anywhere) an
    `overlay: true` node — REGARDLESS of whether a same-`(type, name)` base
    also exists in the same file. A MIXED file (a plain declaration alongside
    an overlay, whether or not that overlay's target is also in this file) is
    still `"overlay"` as a whole — fmt does not partially format a file, and
    it never merges a same-file base+overlay into one node even though the
    ordinary loader would (that merge drops the overlay marker, which is the
    one thing a formatter may never do to a file's structure).
  - `"error"` — any other reason the file cannot be parsed standalone (an
    unregistered type/subtype, a missing required structural key, …).

A port's test runner loads `input.json`, formats it the way its own `fmt`
formats a single file, and asserts the outcome against whichever expectation
file is present. Error/skip *message text* is never compared — only the
`reason` classification, exactly like the loader corpus compares error
*codes*, never message text.

## Fixture naming

Kebab-case, no leading numbers, descriptive of the one behavior under test —
`already-canonical`, `reorder-structural-keys`, `skip-overlay-no-local-base`.
Names persist forever once a fixture exists in CI history.

## Why standalone, not whole-project

A node merged from two files (an overlay, or two plain files that happen to
declare the same `(type, name)`) has no single file whose "own content" it
is — serializing it would either invent attribution or silently drop one
file's contribution. Rather than approximate that, `fmt` only ever rewrites
a file it can prove is a complete, self-contained declaration, and every
other port implements that SAME refusal — which is exactly what the
`"overlay"`/`"error"` fixtures above pin down cross-port.

## Current fixtures

| Fixture | What it proves |
|---|---|
| `already-canonical` | A file that is already canonical round-trips unchanged |
| `reorder-structural-keys` | Structural keys reorder to name → package → extends → abstract → overlay → isArray → @-attrs → children |
| `sort-attrs-alphabetically` | Inline `@`-attrs sort alphabetically regardless of authored order |
| `normalize-scalar-fields-to-array` | A scalar `@fields: "x"` becomes `@fields: ["x"]` |
| `source-rdb-physical-name-rewrite` | A legacy `@table` alongside a non-table `@kind` rewrites to the kind-matching physical-name attr (FR-016/ADR-0018) |
| `preserve-unresolved-cross-file-extends` | An `extends` ref to a base declared in another file is preserved as-is, never an error |
| `skip-overlay-no-local-base` | A file whose only declaration is `overlay: true` with no local base is skipped, reason `"overlay"` |
| `skip-mixed-plain-and-overlay` | A file mixing a plain declaration with an unresolvable overlay is skipped WHOLE, reason `"overlay"` |
| `skip-overlay-redeclares-local-base` | A plain declaration AND a same-`(type, name)` `overlay: true` redeclaration in the SAME file (a local base exists) is still skipped, reason `"overlay"` — never silently merged |
| `skip-structurally-invalid` | A file that cannot be parsed at all (unregistered subtype) is skipped, reason `"error"` |
| `crlf-normalized-to-lf` | A CRLF-line-ended input formats to the LF-only canonical form |
| `bom-stripped` | A UTF-8-BOM-prefixed input parses (BOM stripped) and the output carries no BOM |

## Adding a new fixture

1. `mkdir -p fixtures/fmt-conformance/<fixture-name>`
2. Add `input.json`.
3. Decide happy path vs skip, add `expected.json` or `expected-skip.json`.
4. Run the TS reference runner — `cd server/typescript && bun test packages/metadata/test/fmt-conformance.test.ts` —
   it auto-discovers the new directory.
5. Port the fixture through C# / Java / Python the same way every other
   corpus is ported: run that port's own `fmt`-conformance test and fix the
   port, never the fixture, unless the fixture itself is wrong.
