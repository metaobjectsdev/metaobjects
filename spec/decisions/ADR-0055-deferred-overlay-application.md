# ADR-0055: Overlay application is a deferred pass — plain declarations first, then overlays, each in source order

## Status

**Accepted** (2026-09-12). Additive on the metadata axis: input that previously failed now loads,
the registered vocabulary and canonical format are untouched, so `metamodelVersion` stays `1.0`.
One interleaving on already-loading input changes, pinned by a fixture (see *Consequences*).

Design detail, per-port work, fixture list and open implementation questions:
[`docs/superpowers/specs/2026-09-12-deferred-overlay-application-design.md`](../../docs/superpowers/specs/2026-09-12-deferred-overlay-application-design.md).

## Context

The loader has two cross-file reference mechanisms and deferred only one of them.

`extends` is deferred: the parser records `superRef` and skips resolution
(`server/typescript/packages/metadata/src/parser-core.ts:744`), and the loader resolves every
reference against the fully-merged tree afterwards
(`resolveDeferredSupers`, `server/typescript/packages/metadata/src/loader/meta-data-loader.ts:600`).
So `extends` may target a node declared in any file, in any order.

`overlay: true` was resolved **eagerly**, mid-parse, against whatever happened to be in the
accumulating root at that instant (`createOrFindMetaData`, `parser-core.ts:1047`, throwing at
`:1092-1096`). #160 papered over the resulting fragility with a stable partition that moves
*overlay-only* sources to the end of the load (`meta-data-loader.ts:461`, called at `:547`), but its
predicate is file-level — `declared.length > 0 && declared.every(d => d.overlay)` (`:487`) — so a
**mixed** file (one carrying both plain and `overlay: true` top-level declarations) is classified as a
base and never moved.

The measured consequence, on identical input:

| input | TypeScript / C# / Java | Python |
|---|---|---|
| mixed file, base in a later-ordered source | `ERR_OVERLAY_NO_TARGET`, and the whole source is discarded — its plain declarations vanish and cascade into `ERR_UNRESOLVED_SUPER` | **loads with zero errors**, children `[ov, id]` — the base merged *into* the overlay node — against `[id, ov]` on every other path |
| overlay before its base inside one file | same failure | loads; **two sibling nodes** under the same name |
| overlay-only file, either order | loads (the #160 partition) | loads |

This is not one caller's bug. `docs/features/metadata-dependencies.md:148` documents
overlay-in-its-own-file as a *convention*, not a rule, and nothing enforces it, so any project may
author a mixed file and hit this on every command — `gen`, `verify`, everything.

It also **violates a documented cross-port contract.**
`docs/features/metadata-sources.md:94-103` declares resolved file order a deliberate non-contract —
"Java sorts by basename, C# by full-path ordinal, Python by basename, TypeScript walks depth-first
with files before subdirectories … Every port resolves the same file **set**; only the order within
it is each port's own" — and justifies it in part with "the loader's overlay partition discards caller
order regardless." That justification only ever covered overlay-only files. With a mixed file,
port-private walk order becomes observable: the same file set loads in one port and fails in another,
or worse, loads in both and yields different children order — and children order is part of the
byte-gated canonical contract (`spec/conformance-tests.md`, "Children in declaration order … Overlay
merge appends; it does NOT re-sort").

That is the same class of defect #160 was filed for (`CHANGELOG.md:9697`: "This surfaced as a
cross-port divergence — the TS loader tolerated one discovery order that the Python loader
rejected"). #160 closed the hole for overlay-only files and left mixed files inside it.

Nothing caught it because the shared corpus has **zero** mixed-file cases and zero within-file
overlay-before-base cases; every overlay fixture is "base file + overlay-only file".

## Decision

**Every loader applies `overlay: true` in a post-parse pass, exactly as it already resolves `extends`
in one.** The parser no longer resolves an overlay against the accumulating root when it meets it: it
**queues** the declaration and the loader **applies** the queue once every source has been parsed.

The pipeline is:

1. Parse every source — plain declarations merged as today, overlays queued.
2. **Apply the queued overlays** — all of them, after all plain declarations.
3. Resolve deferred supers.
4. Run the validation passes.

Ordering guarantees, which become the cross-port contract:

- **G1 — plain before overlay.** Every plain declaration from every source is in the tree before any
  overlay is applied. Order among plain declarations is unchanged (source order).
- **G2 — overlays in source order**, declaration order within a source. This is the order the #160
  partition already gave overlay-only files, so their output is preserved exactly.
- **G3 — whole-unit application.** The unit is the *outermost* `overlay: true` node; its subtree,
  nested overlays included, is applied together.
- **G4 — order independence.** Whether a base precedes or follows its overlay — across files or
  within one — affects neither success nor output.
- **G5 — supers after overlays.** Super resolution sees every node an overlay contributed.

An absent target remains `ERR_OVERLAY_NO_TARGET`, now raised per overlay from the post-pass with a
`format: "resolved"` envelope (ADR-0009 §FR5d, mirroring the deferred-super failure path), and
**without discarding the declaring source** — every other declaration in that file survives.

The #160 overlay-only source partition is **retired** in all four ports. `overlay: true` keeps its
meaning as a *guard* — a same-`(type, resolutionKey)` redeclaration merges with or without the flag;
only the flagged form fails when its target is absent — but the assertion it makes changes from
"the target must already be loaded" to "**the target must exist in the source set**," which is what
`order-independence.test.ts` already claims the design guarantees and what the shipped authoring
guidance already describes.

## Consequences

**Input that failed now loads.** A mixed file resolves regardless of where its base sits; so does an
overlay preceding its base in one file. On Python, input that loaded *wrongly* now loads right, and
its single-file duplicate-sibling defect is fixed by the same change.

**One interleaving on already-loading input changes.** A mixed file's overlay followed by a later
**unflagged** redeclaration of the same node moves from `[id, pk, ov, late]` to `[id, pk, late, ov]`,
because G1 puts the plain contribution first. The mirror shape with an overlay-*only* file already
behaves that way and does not move. A conformance fixture pins the chosen order. The shape requires an
unflagged redeclaration, which `WARN_OVERLAY_IMPLICIT` already reports as an authoring anti-pattern —
which is why this is the corner chosen to move.

**Java gains the error code it declared but never emitted.** `ERR_OVERLAY_NO_TARGET` exists at
`server/java/metadata/src/main/java/com/metaobjects/ErrorCode.java:165`, but the JVM throw is a bare
`MetaDataException(String)` (`loader/parser/BaseMetaDataParser.java:366`), so a missing overlay target
reports as `ERR_UNKNOWN`. The code must be attached in the same change, or any cross-port fixture
asserting it lands red on Java.

**Fewer cascaded errors.** An input that produced two errors now produces one, because the failing
declaration no longer takes its file down with it.

**The corpus grows a mixed-file axis** it never had, which is what keeps this closed.

**Diagnostics move format.** `ERR_OVERLAY_NO_TARGET` changes envelope `format` from `json`/`yaml` to
`resolved`; the harness asserts `format`, so the error fixtures encode it.

**Net deletion of machinery.** Four partitions and their overlay-only predicates go, along with the
double read of every source the partition required (once to scan, once to parse). What stays:
`declaredTopLevelKeys` (the `meta verify` overlay lint is its other caller), the `overlay: true`
authoring requirement, and `WARN_OVERLAY_IMPLICIT`.

## Alternatives considered

**Forbid mixed files** — make a file carrying both plain and overlay declarations a load error, so the
file-level partition becomes total. Rejected: it fails the correction bar in
`docs/compatibility-policy.md:87-145`, which admits a new refusal as a PATCH only when **all three** of
"never validly expressible", "produced no correct outcome for anyone" and "mechanical repair" hold. The
own-file rule is documented as a convention, and a mixed file loads correctly whenever its base
precedes it — so two of the three fail, and post-1.0 the refusal would be a Metamodel major. It also
bans a shape rather than fixing the mechanism.

**Reorder declarations inside a file's parse.** Rejected: resolution is per node during the streaming
walk, so an in-file shuffle cannot help; the phase boundary has to span all sources.

**An advisory lint for mixed files.** Rejected: the failure is at load time on every path, and
`server/typescript/packages/cli/src/lib/overlay-lint.ts` is "Advisory only… Deliberately NO severity
constant to flip" — it could only narrate a build that is already broken. Detectability was never the
obstacle; `declaredTopLevelKeys` already computes the predicate, which is the argument for the loader
handling it rather than warning about it.

**Retry-on-miss** — apply eagerly when the target happens to exist, queue only on a miss. Rejected: it
preserves the §3.2 interleaving but moves the mirror one instead, and it keeps behaviour dependent on
whether a target happens to be loaded yet, which is the fragility being removed. One corner must move
either way; the one chosen is the one the toolchain already warns about.
