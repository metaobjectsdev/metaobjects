# ADR-0009 — Loader error envelope + source-on-node

**Status:** Accepted — 2026-05-25
**Applies to:** all language ports (TS, Java, Python, C#)
**Related:** `docs/superpowers/specs/2026-05-25-fr5a-json-shape-loader-errors.md` (the implementation FR); the FR5 family (`fr5b`–`fr5e`) for the remaining error classes; ADR-0006 (AI-first YAML authoring) — YAML positions cross-cut into this; ADR-0001 (cross-language metadata→native-type binding) for the broader "load-time decisions live in generated code, not runtime reflection" principle.

## Context

The metadata loader pipeline in every metaobjects port produces errors when authoring or
loading fails: JSON-shape violations, YAML parse failures, multi-file merge conflicts,
`extends`/reference resolution failures, conformance/validation rule violations, and (in
the future, with FR-003) database-source errors. Today each port's loader raises errors
in an ad-hoc shape — `{code, message}` plus port-specific context — and **none of them
report where the offending node came from**.

This produces a uniformly poor authoring experience:

- A `meta gen` failure says "unknown subtype `enmu`" with no file path, no line, no
  suggestion. The consumer must grep, re-read fixtures, infer the typo.
- A multi-file merge conflict says "duplicate attr `@foo`" but doesn't name the files
  that contributed.
- An `extends: "Bar"` failure says "unresolved super" without identifying which entity
  declared the broken reference or where `Bar` *was* expected to live.

A consumer-feedback survey of 0.6.0 adoption identified this as the dominant "first
hour with MO" friction. The cross-language conformance corpus already enforces an
`ERR_*` `code` taxonomy that's uniform across ports, but everything else is
port-private.

Two architectural decisions are coupled: **(1)** what shape do errors take so a
consumer can act on them, and **(2)** where does the "where did this come from" data
live so multiple error-producing phases (parse, merge, resolve, validate) and
non-error consumers (drift detection, runtime introspection, MCP) can all access it.

## Decision

**(1)** Every loader error carries a structured envelope conforming to a single
cross-port schema (specified below).

**(2)** Every metadata node carries its own provenance: a `source` field on the
metadata base class, populated by whichever loader phase created the node. **`source`
is always populated** — never `undefined` — so consumers never write nullish checks.
For programmatic / test-constructed nodes, `source` is `{ format: "code" }` (no files,
no path). The field is mutated by phases that mutate the node (overlay merge with
semantic change; reference resolution); duplicate declarations with no semantic change
do not update `source` but emit a warning.

### The error envelope schema

```ts
interface LoaderError {
  // REQUIRED — conformance-enforced.
  code: string;                    // ERR_UNKNOWN_TYPE, ERR_BAD_ATTR_VALUE, ...
  message: string;
  source: ErrorSource;             // never undefined

  // RECOMMENDED — populated where the port can; algorithm spec'd below.
  // Conformance does NOT enforce these in the cross-port harness; ports may
  // populate them and run port-private tests, but no port is required to.
  suggestions?: string[];
  fixture?: string;                // canonical fixture name from ERROR_TO_FIXTURE.json
  node?: NodeContext;
}

type ErrorSource =
  // Authoring-time: single JSON file (FR5a).
  | { format: "json";     files: [string];       jsonPath: string }

  // Authoring-time: single YAML file with source-map positions (FR5b).
  | { format: "yaml";     files: [string];       jsonPath: string;
                                                  yamlPosition?: { line: number; col: number } }

  // Post-load: overlay merge that produced semantic change (FR5c).
  | { format: "merged";   files: string[];       jsonPath: string;
                                                  contributors: Contributor[] }

  // Post-load: extends / @via / @objectRef / @payloadRef resolution failure (FR5d).
  | { format: "resolved"; files: string[];       jsonPath?: string;
                                                  referrer?: string;     // fqn of the referrer
                                                  target?: string }      // intended target fqn

  // Future: database-sourced metadata (FR5e, gated on FR-003).
  | { format: "database"; dbLocation: { table: string; id: string }; jsonPath?: string }

  // Programmatic / test construction.
  | { format: "code";     caller?: string };     // optional human label

interface Contributor {
  file: string;
  role: "overlay-base" | "overlay-extension" | "extends-base" | "extends-extension";
}

interface NodeContext {
  type?: string;                   // "field", "object", "template", ...
  subtype?: string;                // "enum", "entity", "prompt", ...
  name?: string;
  fqn?: string;                    // full reference, e.g. "myapp::commerce::Program"
}
```

**Path format.** `jsonPath` is a canonical JSONPath string. The canonical form:

- Dot notation for object keys that match `^[A-Za-z_][A-Za-z0-9_]*$`.
- Bracket notation `[N]` for array indices (zero-based).
- Bracket notation with quoted string `['key']` for object keys not matching the dot rule.
- Root is `$`.
- No trailing dots, no leading double-`$`, no whitespace.

Examples:
- `$.metadata.root.children[0].object.entity.children[1].field.enum.@values`
- `$.metadata.root.children[2]['my-package'].object.entity`

Every port emits this canonical form byte-identically; conformance fixtures verify the
output with exact string comparison.

**File paths.** Every `files[]` entry is relative to the project root (the parent of
`metaobjects/`). Forward slashes on every platform, even Windows. No leading `./`.

### Source-on-node

```ts
// Pseudocode for the cross-port base.
abstract class MetaData {
  abstract readonly type: string;
  abstract readonly subtype: string;
  abstract readonly name: string | undefined;
  // ... existing structural fields ...

  /** Provenance of this node. Always populated by the end of the load pipeline. */
  source: ErrorSource;
}
```

Each loader phase establishes or transforms `source`:

- **Parse phase (JSON):** every node constructed from the file's tree gets
  `{ format: "json", files: [filePath], jsonPath: <built canonically> }`.
- **Parse phase (YAML):** same with `format: "yaml"` plus `yamlPosition` if the
  port's YAML→canonical-JSON desugar preserves source positions (FR5b).
- **Overlay merge phase:** when two file contributions for the same logical node
  combine, run `semantic_diff`:
  - If the diff is **empty** (the new contribution declares attrs/children
    identical to the existing node), `source` is **unchanged**. Emit a warning:
    `WARN_DUPLICATE_DECLARATION` naming both files.
  - If the diff is **non-empty**, the node's `source` becomes
    `{ format: "merged", files: [allContributors.file], jsonPath, contributors: [...] }`.
    `contributors[i].role` is `"overlay-base"` for the originating file,
    `"overlay-extension"` for each later contributor.
- **Reference resolution phase:** when `extends` / `@via` / `@objectRef` / `@payloadRef`
  resolves successfully, the resolved edge does not update the node's `source` (the
  node's own declaration site is what matters). When resolution **fails**, the raised
  error carries `{ format: "resolved", files, referrer, target }` — the node's
  `source` is what the error reports as the referrer's origin.
- **Programmatic construction (tests, plugins):** `{ format: "code" }` with optional
  `caller` label (e.g. `"QueriesTest.makePost()"`). Builders that want to emit
  realistic source info for testing can pass any envelope explicitly.

### `semantic_diff` algorithm

To distinguish duplicate-with-no-change from real overlay-merge, every port implements
the same diff:

1. Sort attrs lexicographically (canonical-JSON order); compare attr-by-attr; values
   are compared by canonical-JSON equality (recursive structural equality, key-order
   independent, whitespace-insensitive).
2. Children are compared as ordered sequences. Two `children[]` arrays are equal if
   their lengths match AND each pair is structurally equal.
3. Reserved structural keys (`name`, `package`, `extends`, `abstract`, `overlay`,
   `isArray`, `value`) participate in the diff like attrs.
4. The `source` field is excluded from the diff (it's loader output, not metadata).

The output is a boolean ("any change?"). Future FRs can extend this to produce
attr-level provenance if needed; FR5a uses only the boolean.

### Canonical-JSON serialization

`source` is **NOT** serialized to canonical JSON. Canonical JSON remains pure
metadata-interchange — what the user typed (or what the database stores), free of
loader-derived state. Conformance round-trip fixtures' `expected.json` is unchanged by
this ADR.

Error fixtures' `expected.json` carries the error envelope (including `source`)
because the harness is testing loader output, not metadata equivalence.

### Warnings channel

Loader output gains a `warnings: LoaderWarning[]` sibling to `errors[]`. Warnings use
the same envelope shape but a `WARN_*` code. Initial warning code:

- `WARN_DUPLICATE_DECLARATION` — emitted by overlay merge when a duplicate-with-no-change
  is detected. `source` references the duplicate-declaring file; `contributors` lists
  the original.

Warnings are advisory; they do not change exit codes. Multi-error / fail-fast policy
applies only to errors (today: fail-fast, per FR5a brainstorm).

## Consequences

### Cross-port adoption sequence

| Port | Source-on-node ready? | Coordinated landing for FR5a? |
|---|---|---|
| **TypeScript** | Not yet — adds `source` field to `MetaData` base. | Yes; FR5a TS section schedules this work. |
| **C#** | Not yet — adds `Source` property to `MetaData` base. | Yes; FR5a C# section. |
| **Java** | Mid-H3b. Loader gains `source` field in the same window as conformance-harness work. | Yes; FR5a Java section. |
| **Python** | Loader Phase 1 (56/60 corpus). Adds `source` field; populated in the parser. | Yes; FR5a Python section. |

The structural field add (`source` on the base class) is small (≤50 lines per port)
but cross-cutting (every node-constructor path). FR5a bundles this with the JSON-source
implementation so subsequent FRs (5b/5c/5d/5e) extend population sites without
re-touching the field shape.

### Conformance corpus migration

Existing error fixtures (~12-15 of them in the corpus) get their `expected.json`
rewritten:

```jsonc
// Before
{ "code": "ERR_UNKNOWN_TYPE" }

// After (FR5a)
{
  "errors": [
    {
      "code": "ERR_UNKNOWN_TYPE",
      "source": {
        "format": "json",
        "files": ["metaobjects/input.json"],
        "jsonPath": "$.metadata.root.children[0].objct.entity"
      }
    }
  ],
  "warnings": []
}
```

The `errors[]` array shape (vs. flat object) is forward-looking: when fail-fast is
revisited later, multi-error fixtures slot in without another rewrite. For FR5a
(fail-fast), `errors[]` is always length-1 in the post-rewrite corpus.

The fixture rewrite is mechanical — each path value is derivable from the input file
by inspection. Done once during the coordinated landing.

### What this unblocks

- **FR5a (JSON-shape errors).** First implementation that exercises the envelope.
- **FR5b (YAML positions).** Just extends the parser to populate `yamlPosition`.
- **FR5c (multi-file merge errors).** The `format: "merged"` discriminant is already
  in the envelope; the merge phase already updates `source`. FR5c surfaces errors that
  reference these.
- **FR5d (reference-resolution errors).** Adds `format: "resolved"`.
- **FR5e (database-source errors).** The `format: "database"` slot waits for FR-003.
- **Drift detection / MCP.** Both consume `node.source` directly — no extra plumbing
  needed.
- **Plugin / programmatic construction with realistic source.** Tooling builders pass
  a `code` envelope (or a fully synthetic one) when constructing nodes for tests or
  generators.

### What ports are NOT required to do in FR5a

- **Populate `suggestions`, `fixture`, `node`** in the error envelope. These are
  RECOMMENDED; conformance doesn't enforce them. Ports may ship them at their own pace.
- **Implement per-attribute source tracking.** Node-level provenance is what FR5a needs.
  Per-attr provenance is left for future work if a downstream FR justifies it.
- **Source-map YAML positions (FR5b).** Out of scope for FR5a; the `yamlPosition`
  optional field is reserved.

## Alternatives considered

### Alt 1: Side-channel `Map<NodeRef, ErrorSource>` instead of on-node

Rejected. Every consumer that wants source (errors, drift, MCP, debug tools) would
need to plumb the map. Stable node references across phases (merge changes node
identity) are a separate design problem this avoids. The "metadata stays clean" win
is overrated — metadata classes already carry parent pointers, sequence numbers, and
other non-semantic loader state. One more field of small semantic state is fine.

### Alt 2: Optional `source` field (nullable in TS, `Optional<>` in Java/C#)

Rejected. Every downstream consumer adds nullish checks; bug-prone. Making `source`
total (always populated, with a `code`/`synthetic` fallback for programmatic construction)
costs essentially nothing and removes a class of error.

### Alt 3: Per-attribute source tracking from the start

Rejected for FR5a as YAGNI. The node-level envelope makes every error actionable in
the cases that matter (JSON-shape, YAML, merge, resolved). If a future FR needs
per-attr provenance — e.g. drift detection wanting to tag "this attr was last
modified by file Y" — we extend then.

### Alt 4: Update `source` on every contribution, including duplicates

Rejected per the brainstorm. A no-op duplicate doesn't shape the node's data; the
`source` field describes "who shaped this node's current state," and a duplicate
shapes nothing. Warning channel surfaces duplicates without polluting `source`.

### Alt 5: Each port emits its own JSONPath dialect

Rejected. Cross-port consumers (drift tools, AI agents triaging multi-language
errors) need byte-identical path strings to compare/match. Canonical form + exact-match
in conformance is the only way.

## References

- TypeScript / C# / Java / Python implementation FR (joint, cross-port): `docs/superpowers/specs/2026-05-25-fr5a-json-shape-loader-errors.md`
- Subsequent FRs (sketches): `docs/superpowers/specs/2026-05-25-fr5b-yaml-loader-source-positions.md`, `fr5c-multi-file-merge-error-attribution.md`, `fr5d-reference-resolution-errors.md`, `fr5e-database-source-errors.md`
- ADR-0001 — Cross-language metadata→native-type binding (the "load-time decisions
  live in generated code" principle this builds on).
- ADR-0006 — AI-first YAML authoring (the substrate FR5b depends on).
- ADR-0008 — Parameter-passing generated repo helpers (companion FR family pattern).
- Industry: JSONPath (RFC track), RFC 6901 (JSON Pointer, considered as alternative
  path format and rejected for readability), Hibernate/JPA's `PropertyAccessException`
  (per-attr provenance precedent, deliberately not adopted in FR5a).
