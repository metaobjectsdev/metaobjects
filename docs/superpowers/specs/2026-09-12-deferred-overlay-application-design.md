# Deferred overlay application — the loader applies `overlay: true` in a post-parse pass (design)

_Status: DESIGN — proposed, awaiting the maintainer's rulings on the open questions in §9._
_Date: 2026-09-12. Written against `main` at `83c66eeb2`._
_Recommended filename: `docs/superpowers/specs/2026-09-12-deferred-overlay-application-design.md`._
_Relates to: #160 (the overlay-only partition), #188 (order-independent super resolution),
ADR-0009 (error envelope; the `resolved` format), ADR-0029 (child addressing), ADR-0039
(own-accessor discipline — the merge lookup is a sanctioned own read), FR-023 (metadata
dependencies; the overlay authoring lint), `docs/compatibility-policy.md` (the correction bar)._

---

## 0. The decisions on one page

| # | Question | Ruling proposed here |
|---|---|---|
| D1 | What changes? | Overlay **application** is deferred the way super **resolution** already is. The parser no longer resolves `overlay: true` against the accumulating root the instant it meets it; it **queues** the declaration, and the loader **applies** the queue after every source has been parsed and before `resolveDeferredSupers`. |
| D2 | Unit of deferral | The **outermost** `overlay: true` node met on the descent (top-level or nested under a plain parent). Its whole subtree — nested overlays included — is applied as one unit. |
| D3 | Ordering contract | **Every plain declaration of every source, in source order; then every queued overlay, in source order (declaration order within a source).** Bases never see an overlay before they exist; overlays keep last-writer-wins among themselves. |
| D4 | Failure | `ERR_OVERLAY_NO_TARGET` moves from a parse-time throw (which today aborts the *whole source*) to a per-overlay post-pass error carrying an ADR-0009 `format: "resolved"` envelope, mirroring the deferred-super failure path. Every failure is reported; nothing else in that source is lost. |
| D5 | Machinery | The #160 overlay-only partition is **deleted** in the three streaming ports and Python's overlay-only root partition is replaced by a two-pass fold. Only the structural walk `declaredTopLevelKeys` survives (the `meta verify` overlay lint depends on it). |
| D6 | Python | Python's loader is *already* post-parse-merge, so it does not fail — it does something worse (§1.5). Its `merge_roots` becomes the two-pass fold; that also fixes a second, unrelated-looking defect (duplicate siblings from one file). |
| D7 | Compatibility | Additive on the metadata axis: input that failed now loads; the registered vocabulary and canonical format are untouched, so `metamodelVersion` does not move. **One** canonical-visible change on already-loading input exists and is pinned by a fixture (§3.2). |
| D8 | ADR | Yes — the ordering contract binds four loaders and is asserted by the shared corpus. Sketch in §8. |

---

## 1. Problem

### 1.1 What `overlay: true` is — a guard, not a merge operator

The parser merges a same-`(type, resolutionKey)` redeclaration **whether or not** it carries the
flag. `createOrFindMetaData` (`server/typescript/packages/metadata/src/parser-core.ts:1047-1110`)
has two arms: with `overlay: true` it is find-or-**throw**; without it, find-or-**create** ("Default:
no operator → silently reuse existing or create new", `:1103-1106`). Measured: two files declaring
`object.entity Y` with neither flagged load cleanly and yield one node with both files' fields.

So the flag adds exactly one thing: a loud failure when the target is absent. That is why the
dependency docs require it on every amendment to a foreign node
(`docs/features/metadata-dependencies.md:148-163`, `docs/features/abstracts-and-inheritance.md:288-295`)
and why `meta verify` lints an unflagged second declaration as `WARN_OVERLAY_IMPLICIT`
(`server/typescript/packages/cli/src/lib/overlay-lint.ts:1-31`). The guard's *value* is that it fires
when the target is gone. Its *defect* is that it also fires when the target is merely **not parsed
yet**.

### 1.2 The root-cause asymmetry: `extends` is deferred, `overlay` is eager

Both are references to a node that may live in another file. They are resolved on opposite schedules:

| | `extends` (super ref) | `overlay: true` |
|---|---|---|
| Parse-time behaviour | With `deferSuperResolution: true` the eager resolve is **skipped**; the raw ref stays on the node as `model.superRef` (`parser-core.ts:742-744`; option at `:95`). | `createOrFindMetaData` looks the target up in the accumulating root **immediately** and throws `ERR_OVERLAY_NO_TARGET` if absent (`parser-core.ts:1091-1096`). |
| Second pass | `resolveDeferredSupers(root)` walks the merged tree after every source is parsed (`server/typescript/packages/metadata/src/loader/meta-data-loader.ts:600`; `super-resolve.ts:273`). | None. |
| Order dependence | None — "a pure function of the source SET" since #188 (`super-resolve.ts:275-290`). | Total: the target must precede the overlay in parse order, **within a file as well as across files**. |

The loader sets `deferSuperResolution: true` on every source it parses (`meta-data-loader.ts:573`).
There is no such option for overlays.

### 1.3 The partition that papers over it, and the hole in it

#160 (`CHANGELOG.md:9697`) added a stable partition that moves *overlay-only* sources to the end of
the parse order: `_partitionOverlayLast` (`meta-data-loader.ts:461-479`, called at `:547`) and
`_isOverlayOnlySource` (`:487-493`), whose predicate is

```ts
declared.length > 0 && declared.every((d) => d.overlay)
```

A **mixed** source — at least one plain declaration *and* at least one `overlay: true` declaration —
fails `every`, is classified as a base, and stays where the basename sort put it. Measured on this
tree (TypeScript, `MetaDataLoader.fromDirectory` over two-file directories; `id`/`pk` are the base's
own field and identity, `ov` the overlay's added field):

| consumer file | base `Y` in a LATER-sorted source | base `Y` in an EARLIER-sorted source |
|---|---|---|
| MIXED (`X` plain + `Y` overlay) | **fails** `ERR_OVERLAY_NO_TARGET` — envelope `{ format: "json", files: ["meta.a.json"], jsonPath: "$['metadata.root'].children[1]['object.entity']" }` | loads, `Y` = `[id, ov]` |
| overlay-only (`Y` overlay) | loads (partition rescues it), `Y` = `[id, ov]` | loads, `Y` = `[id, ov]` |

Two further measurements the design must cover:

- **Within one file** an overlay preceding its base fails identically (`jsonPath … children[0]`):
  resolution is eager per node, not merely per file, so no in-file shuffle can help.
- **A nested overlay under a plain parent** fails the same way when the nested target is in a later
  file: file A declares `C` plain with child `field.string email, overlay: true`; file B declares `C`
  with `email` → `ERR_OVERLAY_NO_TARGET` at `…children[0]['object.entity'].children[2]['field.string']`.

And one side effect the brief did not list: **the eager throw aborts the whole source.** The loader
catches it per source (`meta-data-loader.ts:588-594`) and never assigns `root = parseResult.root`, so
every plain declaration in the failing file is silently dropped (`X` in the mixed case; `id`/`pk` in the
nested case — the surviving `C` had only `email`). Anything that then `extends` those dropped nodes
cascades into `ERR_UNRESOLVED_SUPER`.

This is not caller-specific. `meta gen`, `meta verify`, `meta docs` and any embedder of `MetaDataLoader`
take the same parse loop.

### 1.4 The same defect, by construction, in C# and Java

Both stream each source into one accumulating root and resolve overlays eagerly:

- **C#** — `Parser.CreateOrFindMetaData` (`server/csharp/MetaObjects/Parser.cs:976-1043`) throws
  `ParseException(…, ErrorCode.ERR_OVERLAY_NO_TARGET, …)` at `:1018-1023`; the loader partitions at
  `MetaDataLoader.cs:398` (`PartitionOverlayLast` `:271`, `IsOverlayOnlySource` `:300`,
  `RootIsOverlayOnly` `:332`) and defers supers at `:427`/`:460`.
- **Java** — `BaseMetaDataParser.createOrOverlayMetaData`
  (`server/java/metadata/src/main/java/com/metaobjects/loader/parser/BaseMetaDataParser.java:257-393`)
  throws at `:361-366`; the loader partitions at `MetaDataLoader.java:1670` (`partitionOverlayLast`
  `:1724`, `isOverlayOnlySource` `:1747`, `rootIsOverlayOnly` `:1766`) and defers supers through the
  `pendingExtends` queue (`:205-226`, drained at `:1698`). `ParserYaml extends CanonicalJsonParser`
  and calls the same `buildTree` (`parser/yaml/ParserYaml.java:83,115`) — one door.

**Java finding.** The Java throw is `new MetaDataException(String)` — no `ErrorCode`.
`rethrowWithEnvelope` (`CanonicalJsonParser.java:290-303`) preserves a code only if one was set, and the
conformance harness falls back to scanning the message for an `ERR_*` token
(`ConformanceTest.java:715-727`), of which there is none. `ERR_OVERLAY_NO_TARGET` is declared
(`ErrorCode.java:165`) but **never emitted by the JVM loader**; a missing overlay target reports as
`ERR_UNKNOWN` today. Any cross-port fixture for this code fails on Java until §4.3 lands.

### 1.5 Python does not fail — it does something different (the brief's "every path" is three ports)

Python's loader is parse → merge → super-resolve → validate (`server/python/src/metaobjects/loader/meta_data_loader.py:102-136`):
each source is parsed into its **own** root, and `merge_roots` folds those roots post-parse
(`loader/merge.py:48-79`). The overlay check lives in `_merge_into` (`merge.py:284-293`) and *appends*
an error rather than throwing. Measured with the same inputs:

| input | Python result | vs. TypeScript |
|---|---|---|
| MIXED, base later | loads, **no error**; `Y` = `[ov, id]` and the merged node keeps `is_overlay=True` — the base was merged *into* the overlay node | TS fails; every other path yields `[id, ov]` |
| within one file, overlay before base | loads, **no error**; **two sibling `Y` nodes** in the root (`[ov]` flagged, `[id]` plain) | TS fails |
| within one file, two plain `Y` (no flag) | **two sibling `Y` nodes** | TS merges into one node |
| nested overlay under plain parent, base later | loads, `email @maxLength 80` | TS fails |
| overlay-only first | loads, `[id, ov]` | same |

Two distinct causes: the Python parser never looks up an existing sibling while building a file's
tree (`parser.py:290-430` constructs every node fresh; `is_overlay` is merely recorded at `:352`), so
same-name siblings from one file are never merged; and `merge_roots` merges a matched pair regardless
of *which side* carries the flag, so an earlier overlay root becomes the target. Python's partition
(`_is_overlay_only_root`, `merge.py:89-94`) exists to keep an overlay-only root from becoming
`roots[0]`, the accumulator; the comment cites super-resolution order, a reason #188 has since removed
(`super_resolve.py:52-70` is order-independent). What the partition still does is decide which node
absorbs which — the thing that produced `[ov, id]` above.

The `overlay` flag never reaches canonical output in any port (no `expected.json` in the corpus
contains an `overlay` key; the TS serializer never reads `isMerge`), so the divergence is visible only
as **children order** — but children order is part of the byte-gated canonical contract
(`spec/conformance-tests.md`, "Children in declaration order … Overlay merge appends; it does NOT
re-sort").

### 1.5b Cross-port: a mixed file makes port-private file order observable

`docs/features/metadata-sources.md:94-103` declares resolved file order a deliberate **non**-contract:

> The ports' directory walks already differ and always have — Java sorts by basename, C# by
> full-path ordinal, Python by basename, TypeScript walks depth-first with files before
> subdirectories — and the loader's overlay partition discards caller order regardless
> (super-resolution is order-independent, #188). Every port resolves the same file **set**; only the
> order within it is each port's own.

That is safe only while the partition rescues every overlay. A mixed file defeats the partition
(§1.3), so port-private walk order becomes observable — and the ports disagree about what the
divergence *is*:

- **Load/fail divergence.** Base at top level, mixed file in a subdirectory: TypeScript's
  files-before-subdirectories walk puts the base first and the load succeeds; Java's and Python's
  basename sorts put the mixed file first.
- **Silent content divergence (measured).** Same two files, mixed sorting first: TypeScript fails,
  while Python loads with **zero errors** and yields `Y` = `[ov, id]` — the base merged *into* the
  overlay node — against `[id, ov]` on every other path (§1.5). Children order is part of the
  byte-gated canonical contract (`spec/conformance-tests.md`, "Children in declaration order …
  Overlay merge appends; it does NOT re-sort").

So the present behaviour does not merely fail awkwardly in one caller: for one class of input it
**violates the cross-port contract quoted above**, in the same way #160 did before the partition
(`CHANGELOG.md:9697`: "This surfaced as a cross-port divergence — the TS loader tolerated one
discovery order that the Python loader rejected"). #160 closed that hole for overlay-only files and
left mixed files inside it. Deferred application is what makes the quoted sentence true for all
input, which is why this belongs in the loader and cannot be delegated to a caller fix or an
authoring lint.

### 1.6 Why nothing caught it

The loader corpus (`fixtures/conformance/`, 314 directories) has **zero** mixed-file cases and zero
within-file overlay-before-base cases. Its overlay fixtures are all "base file + overlay-only file":
`overlay-same-object-different-files`, `overlay-attr-last-writer-wins`, `flattened-kitchen-sink`,
`multi-package-extends-overlay-references`, `projection-overlay-abstract-identity` (the #160 guard,
whose overlay basename deliberately sorts first), `xpkg-m2n-through`, `error-xpkg-through-bare`. No
`expected-errors.json` in the corpus asserts `ERR_OVERLAY_NO_TARGET`; the only places that assert the
code are two `dependency-conformance` cases (`fixtures/dependency-conformance/cases.json:782,828`, both
"target genuinely absent") and one Python unit test (`server/python/tests/unit/test_merge.py:98-111`).

### 1.7 Corrections to the brief, stated explicitly

- The throw site is `createOrFindMetaData`, not `parseNodeOrMerge` (no function of that name exists);
  the cited lines `1092-1096` are right.
- The TS loader is `server/typescript/packages/metadata/src/loader/meta-data-loader.ts`, not
  `src/meta-data-loader.ts`. The cited line numbers (`:461`, `:487`, `:547`, `:600`) are correct in
  that file; the validation passes run from `:635` to `:763` (`validateAttrSchema` is the
  "Eighth pass" in that block), and freeze/return follow at `:766-800`.
- "Fails on every path" holds for TypeScript, C# and Java. Python loads and produces a divergent tree
  (§1.5). Python's partition was not added "solely because application is eager"; it decides the merge
  target, and removing it without the two-pass fold would make Python worse, not better.
- The three streaming ports' partitions do exist solely because application is eager; the brief is
  right about them.

---

## 2. Design

### 2.1 The pipeline

```
1. parse every source            overlays are QUEUED, never applied
2. apply the overlay queue       source order → declaration order        ← NEW
3. resolveDeferredSupers         meta-data-loader.ts:600, unchanged
4. validation passes             meta-data-loader.ts:635-763, unchanged
5. freeze, return                meta-data-loader.ts:766-800, unchanged
```

Step 2 must precede step 3 for two reasons, one historical and one structural: #160 records that an
overlay landing after its base broke "any overlay reaching for a not-yet-loaded `extends`/`origin`
target" (`CHANGELOG.md:9697`); and an overlay's **new** children may themselves carry `extends`
(`applyReservedKeys` runs for every freshly created node, `parser-core.ts:653-740`), so super refs are
still being created during step 2.

Step 4 is unaffected because nothing validates across nodes mid-parse in any port (§4 verifies this per
loader). The only mid-parse checks are node-local — reserved-attr misuse, unknown attrs under strict,
bad inline values — and they run at application time on the overlay's own body exactly as they run
today, because application re-enters the same `parseNodeInto` path.

### 2.2 The unit of deferral: the outermost `overlay: true` node

The parser queues the **first** overlay-flagged node it meets on the way down and does not descend
into it. Everything inside — plain children, nested overlays, attrs — is applied together when the
unit is applied. Rationale:

- A nested overlay under a *queued* parent needs no separate entry: by the time the parent is applied
  every base exists, and `parseNodeInto → processChildren → createOrFindMetaData` resolves the nested
  target against a complete parent (the nested arm stays find-or-fail, now at application time).
- A nested overlay under a **plain** parent (the §1.3 `C.email` case) must be queued on its own, with
  its parent being the real node the plain declaration produced or merged into. `processChildren`
  already has that node in hand (`parent` at `parser-core.ts:1460-1475`).
- Queueing at *every* overlay depth would apply a nested overlay twice (once as part of its parent,
  once on its own).

### 2.3 The queue element — what must travel

A deferred super hangs on its node as `model.superRef`. A deferred overlay **has no node** (nothing
was created), so everything the parser would have used must travel out in the parse result. In
TypeScript (`parser-core.ts`, exported beside `ParseResult`):

```ts
export interface PendingOverlay {
  /** Wrapper-key type and subType — the lookup is by (type, name); subType is not consulted. */
  readonly type: string;
  readonly subType: string;
  readonly name: string;
  /** The declaration body, untouched — `parseNodeInto` consumes it at application time.
   *  For YAML input it still carries the desugar's position-by-key map, so nested
   *  children get correct `yamlPosition`s when they are eventually constructed. */
  readonly nodeData: Record<string, unknown>;
  /** The node the target is sought under: the accumulating root for a top-level
   *  overlay, the enclosing (plain) node for a nested one. A live reference — the
   *  tree is mutated in place and nodes are never replaced. */
  readonly parent: MetaData;
  /** The effective context package at the declaration site — needed for the
   *  package-qualified root lookup (`rootChildResolutionKey`, parser-core.ts:372-384)
   *  and for package inheritance of the overlay's new children. */
  readonly inheritedContextPkg: string;
  /** ADR-0009 parse-time provenance of the declaration itself: format, files[0],
   *  jsonPath and (YAML) position. The `files`/`jsonPath` of the eventual error
   *  envelope, and the base of `populateNodeSource` for children created on apply. */
  readonly source: ErrorSource;            // exactly what errSource() returns at queue time
  /** The JSONPath segments at queue time, so the module-level `JsonPathBuilder`
   *  can be re-seeded before re-entering the walk (json-path.ts:18 has push/pop
   *  only today — it gains a snapshot/restore pair). */
  readonly pathSegments: ReadonlyArray<{ kind: "key"; value: string } | { kind: "index"; value: number }>;
  /** FR5b: the declaration's own YAML position (nested positions live in nodeData). */
  readonly yamlPosition?: YamlPosition;
}
```

`registry`, `strict` and the error/warning sinks are loader-scoped and are supplied at application.
`ParseResult` gains one member:

```ts
export interface ParseResult {
  root: MetaRoot;
  warnings: string[];
  errors: ParseError[];
  envelopeWarnings: LoaderWarning[];
  pendingOverlays: PendingOverlay[];      // NEW — empty when nothing was deferred
}
```

Queue order is encounter order. Because the loader parses sources sequentially and the walk is
pre-order, encounter order **is** "source order, then declaration order within a source" — no sort
is needed, and stability is by construction.

### 2.4 Who drains the queue — `ParseOptions.deferOverlays`

Mirror `deferSuperResolution` (`parser-core.ts:95`): a new `deferOverlays?: boolean`. The loader passes
`true` and receives the queue. When the option is absent, `buildTree` drains its own queue at the end
of the document before returning — so a standalone `parseJson`/`parseYaml` call is order-independent
*within its one document*, and a single-document forward overlay stops failing on that door too.
The eager arm inside `createOrFindMetaData` is deleted, not gated: with the option off, "queue then
drain at document end" is the only path (one rule, one door).

### 2.5 The loader step and the ordering guarantees

`applyPendingOverlays(pending, { registry, strict, accumRoot })` is exported from `parser-core.ts`
(it must own the module-level parse state — `_currentPath`, `_currentSourceId`, `_currentFormat`,
`_currentYamlPosition`, `_currentErrors`, `_currentEnvelopeWarnings`, `_deferSuperResolution` —
which `buildTree` resets in its `finally` at `:632-640`). Per element, in queue order:

1. Re-seed the module state from the element (`pathSegments`, `source.files[0]`, `source.format`,
   `yamlPosition`), with `_deferSuperResolution = true`.
2. Look the target up exactly as `createOrFindMetaData` does today (`parser-core.ts:1079-1090`,
   own-children by `(type, name)`, package-qualified at the root — the ADR-0039 sanctioned own read),
   factored into a shared `findOverlayTarget(parent, type, name, nodeData, ctxPkg)` so the lookup has
   one implementation.
3. Found → `existing.setIsMerge(true); parseNodeInto(nodeData, existing, accumRoot, ctxPkg, …)` —
   the same call the eager arm makes at `:1097-1099`. FR5c conflict detection, `MergedSource`
   attribution and `WARN_DUPLICATE_DECLARATION` all run inside `parseNodeInto` and are untouched.
4. Not found → record the failure (§2.6) and **skip the element**. `parseNodeInto` was never
   entered, so no partial state exists to unwind.
5. A throw during application (strict-mode `reportProblem`, a registry error) is caught per element
   and recorded, as the parse loop already does per source (`meta-data-loader.ts:588-594`).
6. Reset the module state in a `finally`, as `buildTree` does.

The loader calls it once, after the parse loop and before `resolveDeferredSupers`
(`meta-data-loader.ts:598-600`), concatenating every source's `pendingOverlays` in parse order.

**Guarantees (the cross-port contract, to be written into `spec/conformance-tests.md`):**

- **G1 — plain before overlay.** Every plain declaration from every source is in the tree before any
  `overlay: true` declaration is applied. Load order among plain declarations is unchanged: source
  order, i.e. the FR5c case-sensitive basename sort.
- **G2 — overlays in source order.** Among overlays, application order is source order, then
  declaration order within a source. This is the order the #160 partition already gave overlay-only
  files, so their attribute last-writer-wins and children-append order are preserved exactly.
- **G3 — whole-unit application.** A queued subtree is applied depth-first in declaration order, as
  today.
- **G4 — order independence of the base/overlay relation.** Whether a base precedes or follows its
  overlay — across files or within one — no longer affects success or output.
- **G5 — supers after overlays.** `resolveDeferredSupers` sees every node an overlay adds.

**Last-writer-wins, precisely.** Under FR5c two contributors setting the same `@attr` to *different*
non-empty values is `ERR_MERGE_CONFLICT` regardless of order (`parseNodeInto`, `parser-core.ts:857-864`;
`spec/conformance-tests.md` "Multi-file load order"). So order is observable only for (a) an attr set
on one side and empty on the other — the set side wins either way — and (b) **children append order**.
G1+G2 fix (b): base children first, then overlay children in source order. Among bases nothing
changes; among overlays nothing changes; the one base/overlay interleaving that *can* differ from today
is §3.2.

### 2.6 Error reporting

`ERR_OVERLAY_NO_TARGET` keeps its code (`errors.ts:77`, `ERROR-CODES.json:32`) and becomes a post-pass
error built the way the deferred-super failure is built (`meta-data-loader.ts:600-635`;
`super-resolve.ts:238-262` for the failure record; `source.ts:87-98` for `resolvedSource`):

```ts
new ParseError(
  `Overlay operation requested for [${type}:${key}] but no existing metadata found to merge into`,
  { code: "ERR_OVERLAY_NO_TARGET",
    source: resolvedSource(pending.source, /* referrer */ key, /* target */ `${type}:${key}`) },
)
```

- `format: "resolved"` (ADR-0009 §FR5d: reference-resolution failures), with `files` and `jsonPath`
  copied from the parse-time envelope — the harness asserts exactly those three
  (`spec/conformance-tests.md`, "Errors and warnings"). `referrer`/`target` are informational: the
  overlay's own resolution key (`acme::Y`, or `acme::C.email` for a nested one, ADR-0029 addressing)
  and the `(type, key)` it looked for. §9 Q1 holds the alternative of keeping the parse-time format.
- **All** failures are reported, not the first; the failing declaration's source keeps every other
  contribution. The measured "sibling declarations vanish and cascade into `ERR_UNRESOLVED_SUPER`"
  behaviour (§1.3) goes away — an input that produced two errors produces one.

### 2.7 What is deleted

| Port | Removed | Why it existed |
|---|---|---|
| TypeScript | `_partitionOverlayLast` (`meta-data-loader.ts:461`), `_isOverlayOnlySource` (`:487`), the call at `:547`, the eager arm at `parser-core.ts:1091-1096` | eager application |
| C# | `PartitionOverlayLast` (`MetaDataLoader.cs:271`), `IsOverlayOnlySource` (`:300`), `RootIsOverlayOnly` (`:332`), the call at `:398`, the throw at `Parser.cs:1018-1023` | eager application |
| Java | `partitionOverlayLast` (`MetaDataLoader.java:1724`), `isOverlayOnlySource` (`:1747`), `rootIsOverlayOnly` (`:1766`), the call at `:1670`, the throw at `BaseMetaDataParser.java:361-366` | eager application |
| Python | `_is_overlay_only_root` (`merge.py:89-94`) and the partition at `:80-82`; the error-then-append arm at `:284-293` | choosing the merge target |

The partition also read every source twice (once to scan, once to parse); that goes too.

**What stays.** `declaredTopLevelKeys` (`meta-data-loader.ts:155`, exported at `index.ts:248`) — the
overlay lint is its second caller and remains one. `RESERVED_KEY_OVERLAY` (`shared/structural.ts:15`),
`MetaData.isMerge` (`shared/meta-data.ts:51,276`), the `overlay: true` authoring requirement, and
`WARN_OVERLAY_IMPLICIT` are all unchanged.

---

## 3. Behaviour changes

### 3.1 Input that failed and now loads (TS / C# / Java), or loaded wrongly and now loads right (Python)

| Input | TS / C# / Java today | Python today | After (all ports) |
|---|---|---|---|
| Mixed file; base in a later-sorted file | `ERR_OVERLAY_NO_TARGET`; the mixed file's plain declarations dropped | loads; `[ov, id]`, node flagged | loads; `[id, pk, ov]` |
| Overlay before base in one file | same error | loads; **two** sibling nodes | loads; one node, `[id, pk, ov]` |
| Nested overlay under a plain parent; nested target in a later file | same error, deep `jsonPath`; parent's own fields dropped | loads correctly | loads; identical to Python today |
| Two plain same-name declarations in one file | merged | **two** sibling nodes | merged (Python joins the other three) |
| Overlay with no base anywhere | error, `format: "json"/"yaml"`, whole source dropped | error appended **and** the stray node still added to the tree | error, `format: "resolved"`; stray node not added; siblings kept |
| Overlay-only file first (#160) | loads via partition | loads via partition | loads via G1 — the partition is gone, `projection-overlay-abstract-identity` is the regression guard |

### 3.2 The one canonical-visible change on input that loads today

Three files: `meta.a.json` base `Y` (`id`, `pk`); `meta.b.json` **mixed** (`X` plain + overlay `Y`
adding `ov`); `meta.c.json` an **unflagged** redeclaration of `Y` adding `late`.

- Today (TS, measured): `[id, pk, ov, late]` — the mixed file's overlay applied at its own position.
- After: `[id, pk, late, ov]` — G1 puts the unflagged (plain) contribution first.

This is the only shape whose output moves: a mixed file's overlay *that succeeds today* followed by a
later **unflagged** redeclaration of the same node. Both halves are things the toolchain already
discourages (the unflagged second declaration is exactly `WARN_OVERLAY_IMPLICIT`). The mirror shape
with an overlay-**only** file (`meta.b.json` holding just the overlay) is `[id, pk, late, ov]` **today
and after** — the partition already applied it last. So the design converges the mixed-file case onto
the behaviour the overlay-only case has had since #160. A fixture pins it (§5).

The alternative — "apply eagerly when the target exists, queue only on a miss" — preserves this shape
but moves the mirror one (an overlay-only file sorted after its base would apply at its own position,
before a later unflagged contribution, where the partition applies it last today). One corner must
move either way; §9 Q3 asks which.

### 3.3 Diagnostics

- `ERR_OVERLAY_NO_TARGET` envelope format: `json`/`yaml` → `resolved` (files + jsonPath unchanged).
- Fewer cascaded errors, as above. No new codes, no removed codes.
- `WARN_DUPLICATE_DECLARATION`, `ERR_MERGE_CONFLICT`, `MergedSource` contributors (alphabetical, per
  FR5c) — unchanged; they are computed inside `parseNodeInto` at application time from the same inputs.

### 3.4 What CANNOT change

- Every existing `expected.json` / `expected-errors.json` / `expected-effective.json` in
  `fixtures/conformance/` stays byte-identical in all four ports — the implementation gate, not a hope.
- The set of error codes; the `overlay: true` guard semantics (an absent target still fails);
  the FR5c basename-sort load order among plain declarations; canonical output never carrying `overlay`.
- Registered vocabulary and `expected-registry.json`: untouched. `metamodelVersion` stays `1.0`.
  `scripts/check-metamodel-version.mjs` will see no manifest diff; the rule change is prose, so the
  CHANGELOG entry answers the "does this release refuse anything it used to accept?" question
  (`docs/compatibility-policy.md:139-146`) with **no** — it accepts more.
- The `dependency-conformance` cases asserting the code (`cases.json:782,828`; asserted by
  `sdk/test/dependency-conformance.test.ts:151` and `tests/conformance/test_dependency_conformance.py:138`)
  keep passing — they assert the code only, and the target is genuinely absent.
- Under `docs/compatibility-policy.md` this is not a metamodel break and needs no correction-bar
  argument: nothing that loads stops loading. It is a loader bug fix shipped by every port that has a
  loader (four registries; Kotlin inherits the JVM's).

---

## 4. Per-port work

The four loaders are TypeScript, C#, Java and Python. **Kotlin has no loader** — `metadata-ktx` forwards
to the Java `MetaDataLoader` (`fixtures/conformance/README.md:17-30`) and inherits the fix.

### 4.1 TypeScript (reference)

Validation is post-parse: `resolveDeferredSupers` at `meta-data-loader.ts:600`, then the numbered
passes `:635-763` (`validateSubtypeRules` … `validateOriginPaths` … `validateRelationships` …
`validateIndexLookupFields` … `runRegisteredValidation` … `validateAttrSchema` … `validateFieldDefaults`),
freeze at `:778`. Mid-parse checks are node-local only (`reportProblem`, reserved-attr, strict unknown
attrs). **Not a blocker.**

- `parser-core.ts`: `PendingOverlay`, `ParseResult.pendingOverlays`, `ParseOptions.deferOverlays`,
  `findOverlayTarget`, `applyPendingOverlays`; `createOrFindMetaData` queues instead of throwing; a
  module-level `_pendingOverlays` sink beside `_currentErrors` (`:391-410`); `buildTree` drains when
  not deferred.
- `json-path.ts`: `JsonPathBuilder.snapshot()` / `restore(segments)` (or a `fromSegments` factory).
- `loader/meta-data-loader.ts`: pass `deferOverlays: true` (`:573`), collect `pendingOverlays` in the
  loop (`:580-586`), call `applyPendingOverlays` before `:600`, build the `resolved` error; delete the
  partition.
- Tests to reword, not delete: `metadata/test/declared-top-level-keys.test.ts:112-140` (asserts the
  overlay-first load — still true; its rationale names the partition),
  `sdk/test/order-independence.test.ts:23-24,170-180` (permutation test; extend it with a mixed file),
  `docs-site/test/overlay-order.test.ts:8-11` (comment only).

### 4.2 C#

Validation is post-parse: `SuperResolve.ResolveDeferredSupers` at `MetaDataLoader.cs:460`, passes
`:493-643`, freeze `:660`. **Not a blocker.**

- `Parser.cs`: `ParseResult` (`:83`) gains `PendingOverlays`; `ParseState` (`:152`) already captures
  registry, strict, source id, format, `YamlPositionsByPath` and `Builder` — a pending element can
  hold the `ParseState` reference plus parent, `JsonElement`, context package and path string.
- **`JsonElement` lifetime.** `ParseJson` keeps the `JsonDocument` alive only while `buildTree` walks
  it (`Parser.cs:116-138`). A queued element outlives that: store `nodeData.Clone()` (detached) or
  keep the document alive until the loader has applied the queue. A unit test must apply a queued
  overlay *after* its document is disposed.
- `Loader/MetaDataLoader.cs`: `DeferOverlays = true` beside `DeferSuperResolution` (`:427`), collect,
  apply before `:460`, build the error with `ResolvedSource.From(...)` as the super path does
  (`:466-470`); delete `PartitionOverlayLast` / `IsOverlayOnlySource` / `RootIsOverlayOnly`.

### 4.3 Java (+ Kotlin transitively)

Validation is post-load: `resolvePendingExtends()` at `MetaDataLoader.java:1698`, `ValidationPhase.run`
at `:1705`. Mid-parse the parser throws only node-local structural errors (name required, unknown
subtype) and *records* strict `ERR_UNKNOWN_ATTR` via `getLoader().addError` (`CanonicalJsonParser.java:1249-1256`)
— no cross-node validation. **Not a blocker.**

- The precedent is `pendingExtends` (`MetaDataLoader.java:205-226`): the parser calls
  `getLoader().addPendingExtends(...)` from `createOrOverlayMetaData` (`BaseMetaDataParser.java:387-389`)
  and the loader drains after the loop. Add `PendingOverlay` + `addPendingOverlay` + `applyPendingOverlays()`,
  drained at `:1697` **before** `resolvePendingExtends()`.
- A `CanonicalJsonParser` instance is per source and owns the `jsonPathBuilder` and (YAML) position
  map (`:225-240`). The queue element holds the parser instance, `parent`, the body `JsonObject`, the
  reserved keys `processNode` already extracted (`:694-707`), and the path at queue time. `processNode`
  returns early after queueing (skipping `processAttributes`, `processChildrenArray` and FR5c
  attribution at `:797-861`); a new `applyPendingOverlay` re-seeds the builder and runs that same tail.
- **Emit the code.** The new failure is `new MetaDataException(msg, ErrorCode.ERR_OVERLAY_NO_TARGET, envelope)`
  (constructor at `MetaDataException.java:194`) with a `ResolvedSource` envelope (already imported by
  `ValidationPhase.java`). Whether to `addError` every failure or throw the first follows the
  `resolvePendingNode` precedent (`:400` throws) — §9 Q5.
- `metadata-ktx`: nothing to do; `integration-tests-kotlin` re-runs green.

### 4.4 Python

Validation is post-merge: `resolve_supers` at `meta_data_loader.py:133`, `run_validations` at `:135`.
**Not a blocker** — but Python's change is a different shape, because its parser does not stream:

- `merge.py` `merge_roots` becomes a **two-pass fold into a fresh accumulator** that adopts the first
  root's `package` (TS's merged root *is* the first file's root, `parser-core.ts:intoRoot`, so the
  canonical root must match). Pass 1 folds every root's children — **including `roots[0]`'s** —
  child by child through the existing `(type, key)` match (`merge.py:270-282`), queueing any
  `is_overlay` node met (top-level, or nested inside `_merge_into`) with its matched parent instead of
  merging it. Pass 2 applies the queue in encounter order; a miss appends `ERR_OVERLAY_NO_TARGET`
  with a `ResolvedSource` (`source/error_source.py:117`) and does **not** add the stray node.
- Folding `roots[0]` through the matcher is what merges same-name siblings from one file (§1.5,
  rows 2 and 4) — no parser change needed.
- Delete `_is_overlay_only_root`. `resolve_supers` and `run_validations` stay where they are.
- `tests/unit/test_merge.py:98-111` keeps passing (a missing target still yields the code); add the
  §6 cases.
- The dependency-conformance harness (`test_dependency_conformance.py:130-145`) is unchanged.

---

## 5. Conformance strategy

Fixture format per `spec/conformance-tests.md` ("Fixture directory format") and
`fixtures/conformance/README.md` ("A scenario directory"). All are `input/*.json` + `expected.json`
unless marked error. Names follow the `<topic>-<scenario>` / `error-<topic>-<scenario>` convention.

| Fixture | Files | Pins |
|---|---|---|
| `overlay-mixed-file-base-in-later-file` | `meta.a.json` mixed (`X` + overlay `Y`+`ov`), `meta.b.json` base `Y` | the headline defect; `Y` = `[id, pk, ov]`, `X` present |
| `overlay-mixed-file-base-in-earlier-file` | same two files, basenames swapped | byte-identical `expected.json` to the row above — G4 |
| `overlay-same-file-before-base` | one file: overlay `Y` then base `Y` | in-file order independence; one node |
| `overlay-nested-under-plain-parent-base-later` | `C` plain with `email overlay:true @maxLength`; later file declares `email` | D2's nested-unit rule; `email` carries the attr |
| `overlay-applies-after-all-plain-declarations` | the §3.2 three-file shape | G1 over an unflagged later contribution: `[id, pk, late, ov]` |
| `overlay-two-overlays-source-order` | base + two overlay files each adding a field | G2: children in basename order |
| `error-overlay-no-target` | one file, one overlay, no base | code + `format: "resolved"` + `files` + `jsonPath` of the declaration |
| `error-overlay-no-target-nested` | plain parent with a nested overlay nobody declares | deep `jsonPath`; single error, no cascade |
| YAML twin of the first row in the YAML corpus | sigil-free `overlay: true` | the `resolved` envelope derived from a `yaml` parse-time source |

Notes:

- An error fixture cannot also assert the surviving tree (exactly one of `expected.json` /
  `expected-errors.json`); "siblings are kept" is a per-port unit test (§6).
- **No existing fixture asserts the eager-throw behaviour.** The only `expected-errors.json` among the
  overlay fixtures is `overlay-attr-last-writer-wins` (`ERR_MERGE_CONFLICT`, `format: "merged"`), which
  is unchanged. `projection-overlay-abstract-identity` must stay green with the partition deleted.
- Both `dependency-conformance` cases keep their `expectLoadError` (code-only assertion).
- Until §4.3 lands, `error-overlay-no-target` is red on Java (it reports `ERR_UNKNOWN`). Land the Java
  code fix in the same change, not via the expected-failures ledger.
- `docs/CONFORMANCE.md:28,122,262` carry the corpus count (314); bump with the additions.
- `spec/conformance-tests.md` "Multi-file load order (FR5c)" gains the G1/G2 sentences; `ERROR-CODES.json`
  needs no change.

---

## 6. Test plan

**Cross-port** — the §5 fixtures, run by all four loader harnesses; plus the whole existing corpus
byte-identical (the "what cannot change" gate). Prove the gate by breaking it: temporarily restore the
eager arm in one port and confirm the new fixtures go red there.

**Regression matrix** (per port, unit level, from §1.3/§1.5):

1. mixed / base later → loads, `[id, pk, ov]`, `X` present, zero errors.
2. mixed / base earlier → unchanged output.
3. overlay-only / base later, and / base earlier → unchanged output, with the partition deleted.
4. within-file overlay-before-base → loads, one node.
5. nested overlay under plain parent, target later → loads with the attr.
6. no target anywhere → exactly one `ERR_OVERLAY_NO_TARGET`, `format: "resolved"`, `files`/`jsonPath`
   equal to the declaration's parse-time envelope; every sibling declaration of that file present;
   no stray node; no `ERR_UNRESOLVED_SUPER` cascade from a sibling that `extends` a kept node.
7. §3.2 three-file shape → `[id, pk, late, ov]`.
8. an overlay that adds a child carrying `extends` to a node in another file → resolves (G5).
9. permutation: every ordering of {base, mixed, overlay-only, unflagged} files yields identical
   per-object canonical output (extend `sdk/test/order-independence.test.ts`).
10. `WARN_DUPLICATE_DECLARATION` and `ERR_MERGE_CONFLICT` still fire from a deferred overlay.

**Port-specific**

- TS: `parseJson` without `deferOverlays` self-drains (forward overlay in one document loads);
  `JsonPathBuilder` round-trips a snapshot; module state is reset after `applyPendingOverlays` throws.
- C#: a queued overlay applied after its `JsonDocument` is disposed.
- Java: the deferred failure carries `ErrorCode.ERR_OVERLAY_NO_TARGET` and a `ResolvedSource`
  (the harness's `extractErrorCode` reads the code, not the message); YAML input through `ParserYaml`
  queues and applies identically.
- Python: two plain same-name siblings in one file merge; the merged root's `package` equals the
  first file's; a failed overlay adds no node; `merge_roots`' public signature is unchanged.

**Gates to run**: `cd server/typescript && bun test` (scoped per package), the C#/Java/Python
conformance runners via `scripts/ci-local.sh --only <port>`, and the `gates` lane for
`check-metamodel-version.mjs` (expect: no manifest diff, prose question only).

---

## 7. Documentation to update

- `docs/features/loaders.md:18` ("Load order is a deterministic ordinal-filename sort (because overlay
  merge is order-sensitive)") and the pipeline steps at `:142-150` — step 4 becomes a deferred pass
  described like step 5 ("deferred, not eager … order-independent").
- `spec/conformance-tests.md` "Multi-file load order (FR5c)" — add G1/G2; `spec/wire-format.md:56`.
- `docs/features/abstracts-and-inheritance.md:272-295`, `docs/features/metadata-dependencies.md:148-163`
  — the own-file convention stays a convention; state that file order no longer matters to overlays.
- `CHANGELOG.md` `[Unreleased]` → **Fixed**, naming the mixed-file case, the Python divergence, the Java
  code, the envelope format change, and the §3.2 ordering change; state that `metamodelVersion` does not
  move.
- `docs/features/metadata-sources.md:94-103` — the "two things are deliberately not cross-port
  contracts" block cites "the loader's overlay partition discards caller order regardless" as part of
  why resolved file order is not a contract. The partition is deleted; restate the reason as deferred
  overlay application (G4) so the non-contract still has a live justification. See §1.5b.
- Agent-context skills: **settled, no ordering-driven regeneration needed.**
  `agent-context/skills/metaobjects-authoring/SKILL.md:1121-1127` and
  `agent-context/skills/metaobjects-verify/SKILL.md:118-124` are the only two skill files mentioning
  `ERR_OVERLAY_NO_TARGET`, and both describe it purely as a missing-target guard ("when the target is
  gone", "the day the target is renamed or removed") — never as an ordering constraint. They are
  already correct under this design; today's eager implementation is what diverges from them. Revisit
  only if the envelope-format change (Q1) is ever documented in skill prose, which it is not today.

---

## 8. ADR — yes, and its shape

This changes a contract that binds four loaders and is asserted by the shared corpus (children order
under merge; when a reference-class error is raised; its envelope format). That is the
`spec/decisions/README.md` bar: cross-cutting and durable. **Written and Accepted as**
[`spec/decisions/ADR-0055-deferred-overlay-application.md`](../../../spec/decisions/ADR-0055-deferred-overlay-application.md)
(2026-09-12). Sketch as drafted:

> **ADR-0055: Overlay application is a deferred pass — plain declarations first, then overlays, each in source order**
>
> **Status.** Proposed (2026-09-12). Additive on the metadata axis; `metamodelVersion` unchanged.
>
> **Context.** `extends` resolves after every source is parsed; `overlay: true` resolved eagerly
> against the accumulating root, so a mixed file whose overlay target lived in a later-sorted file
> (or later in the same file) failed `ERR_OVERLAY_NO_TARGET` in TS/C#/Java, while Python merged the
> base into the overlay node and yielded a different children order — a latent cross-port
> divergence no fixture exercised. The #160 partition rescued overlay-only files only.
>
> **Decision.** Every loader applies `overlay: true` declarations in a post-parse pass: (1) all plain
> declarations in source order; (2) all overlays in source order, declaration order within a source,
> the outermost overlay node being the unit; (3) deferred super resolution; (4) validation. An absent
> target is `ERR_OVERLAY_NO_TARGET` with a `format: "resolved"` envelope, reported per overlay
> without discarding the declaring source. The overlay-only source partition is retired.
>
> **Consequences.** Input that failed now loads; one interleaving on already-loading input changes
> (a mixed file's overlay followed by a later unflagged redeclaration), pinned by fixture. Java gains
> the error code it declared but never emitted. Python's single-file duplicate siblings are merged.
>
> **Alternatives considered.** Forbid mixed files (fails the correction bar — the convention is
> documented as optional and the shape loads correctly whenever its base precedes it); in-file
> reordering (resolution is per node, not per file); an advisory lint (cannot prevent a load-time
> failure); retry-on-miss deferral (moves a different ordering corner, §3.2).

---

## 9. Open questions — each with what settles it

- **Q1 — Envelope format for the deferred failure.** `resolved` (this spec; ADR-0009 §FR5d, mirrors
  the super path, and `resolvedSource` keeps `files`/`jsonPath`) or the parse-time `json`/`yaml`
  envelope (smaller change; the failure *is* the declaration's own location). The harness asserts
  `format`, so the new error fixture pins whichever is chosen. **Settled by:** a maintainer ruling
  against ADR-0009's definition of `resolved`; also decide the `referrer`/`target` strings.
- **Q2 — Overlay-on-overlay across files in reverse order.** File A (sorts first) re-opens `Y.ov`,
  file B's overlay *adds* `ov`. Single-pass source order (this spec) fails A, as the partition does
  today for overlay-only files; a fixpoint pass would make it succeed. **Settled by:** deciding whether
  that authoring shape is supported; either way a fixture (happy or error) records it.
- **Q3 — Which ordering corner moves (§3.2). SETTLED 2026-09-12 — maintainer ruling: this spec's
  order stands.** All plain declarations first, then all overlays (G1/G2); the mixed-file corner moves
  onto the behaviour overlay-only files have had since #160, and the retry-on-miss variant is rejected.
  Reasons of record: retry-on-miss keeps behaviour dependent on whether a target happens to be loaded
  yet — the fragility being removed — and the corner that moves requires an unflagged redeclaration,
  which `WARN_OVERLAY_IMPLICIT` already reports as an anti-pattern. Recorded in ADR-0055; the
  `overlay-applies-after-all-plain-declarations` fixture pins it.
- **Q4 — Standalone `parseJson`/`parseYaml`.** Self-drain at document end (this spec; one door) or
  keep the eager arm when `deferOverlays` is off (mirrors `deferSuperResolution` exactly).
  **Settled by:** grepping in-tree callers of `parseJson` that assert an overlay error, and the ruling.
- **Q5 — Java: record all failures or throw the first.** `addError`+continue gives TS-equal code sets on
  multi-error fixtures; `resolvePendingNode` throws first. **Settled by:** whether any planned fixture
  needs two overlay errors from one load; if not, follow the extends precedent.
- **Q6 — Python's fresh accumulator.** Does any fixture's merged root carry own attrs or a package
  that the first root does not? **Settled by:** running the corpus after the change — the
  `expected.json` bytes decide.
- **Q7 — Release classification.** A loader bug fix that also moves one interleaving on loading input:
  PATCH (output-changing bug fix) in all four registries, or MINOR because the loading rule is relaxed.
  **Settled by:** `docs/compatibility-policy.md` reading at cut time; the CHANGELOG sentence either way.
- **Q8 — Should `WARN_OVERLAY_IMPLICIT` also name the §3.2 interleaving?** The lint already flags the
  unflagged redeclaration; whether to add a hint that its order relative to overlays changed.
  **Settled by:** whether any adopter estate produces the shape (`meta verify` over the estates).
