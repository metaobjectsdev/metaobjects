# The requirements documentation surface — generate the view, never annotate the docs

**Status:** design, ready to plan. Additive; no vocabulary change, no breaking change.
**Depends on:** nothing. **Unblocks:** the structural test link, once FR-038 ships (§7).

`meta docs` gains a third surface, `requirements`, that renders the declared `requirement.*`
ledger as documentation. It emits two files: one for people, one for machines. It reads
metadata and nothing else.

---

## 1. The problem, measured

A capability ledger and a documentation set answer overlapping questions, and only one of them
is disciplined.

Measured against an adopting estate (an external project; the numbers are reported here, not
reproducible from this repository):

| | |
|---|---:|
| requirement nodes in the ledger | ~321 |
| `@implementedBy` claims across them | ~790 |
| `ERR_REQUIREMENT_*` diagnostics on a `verify` run | **0** |
| that project's specification documents carrying **no** status line | 193 of 403 |
| distinct unnormalised spellings of status found in prose | 7+ |

The ledger is loaded, validated and gated in five language ports. The prose is not checked by
anything. That estate had already hand-written a ~165-line script to render a registry view out
of its own ledger — the demand signal for this feature, and evidence that the missing piece is
an emitter rather than a format.

## 2. The direction inverts — the ruling that shapes everything below

The original request was the opposite of this design: **annotate the documents with requirement
references, then strip the annotations at deployment.** That was declined by a two-arm
challenge, both arms independently, on two grounds:

1. An annotated document is **a second authoring surface that must track the model** — the
   duplication this project exists to remove.
2. "This passage depends on `@promptStyle` living on `template.prompt`" is a
   **violation-predicate wearing documentation clothing**, which
   [`spec/capability-ledger.md`](../../../spec/capability-ledger.md) already rules out.

**So the doc view is generated FROM the ledger.** Nothing is authored twice, and the view cannot
drift from the model because it has no independent existence.

The "stripper" the original ask needed **already exists as a convention** and requires no code:
`description` is chartered user-facing and `notes` is internal-only, never emitted to generated
user-facing documentation ([`spec/metamodel/documentation.json:15,39`](../../../spec/metamodel/documentation.json)).
This surface honours that split; it does not reinvent it.

## 3. There is no test link, and that is deliberate

**Decided by challenge on 2026-08-21** (record: `requirements-doc-derived-testlink`, pinned at
`415549d63`; two arms, same verdict, reached from disjoint premises).

The question put was whether the generated documentation should **scan the repository's test
sources** and render a derived "verified by" link, with the `@verifiedBy` attribute staying
retired from source metadata. The intent behind it is sound and is preserved everywhere else in
this design — *observed evidence belongs in the output, not in the prescriptive source.* The
scan fails on a narrower and more concrete point.

**There is no join key left to scan on.**

- **`name` / the dotted path** are author-chosen. The retirement's argument —
  *"the author picks the string, so the cheapest way to satisfy the check is to find a name
  that already exists"*
  ([`verified-by-retirement.md:111-115`](../../features/migrations/verified-by-retirement.md)) —
  applies verbatim, and worse: the requirement `name` also keys the future generated stub path
  (§7), so gaming a published column would corrupt codegen identity.
- **`@implementedBy` is disqualified by measurement, for this exact use.** FR-038 §7 records
  that round 5 of the requirements investigation found it *"worthless **for retrieval** (11/24
  with structured links against 12/24 with entities named in prose)"*, and salvages it only as
  *"a **mechanical** codegen input … not a retrieval hint"*
  ([design §7](2026-08-15-fr-038-requirement-derived-test-stubs-design.md)). Structured links
  scored **worse than prose**. A documentation scan is retrieval.
  It is also legal on **L4/L5 only** ([`spec/metamodel/requirement.json:69-76`](../../../spec/metamodel/requirement.json)),
  so the upper tiers of any ledger have no key at all; and it is unbounded where present — one
  architectural requirement claimed by 123 entities would render as "verified by" essentially
  every test in the estate.
- **The corpus classifier is gone too.** The deleted scan's own module header called its
  test-file patterns *"a GUESS about someone else's repository"*, and the seam that let a
  project correct it (`verify.testFiles`) was deleted with it.

**Labelling it "unverified mention" does not rescue it.** Comment-only matches were already
downgraded to a warning, which reaches one of the four audited failures; the other three are
semantic, and no lexical rule reaches them
([`verified-by-retirement.md:113-115`](../../features/migrations/verified-by-retirement.md)).

**And it would contradict five shipped statements**, which is the specific failure that forced
the retirement in the first place — two load-bearing statements disagreeing about this same
vocabulary:

| where | what it says |
|---|---|
| [`docs/features/migrations/verified-by-retirement.md:118-126`](../../features/migrations/verified-by-retirement.md) | "Nothing yet, deliberately … the replacement inverts the direction" |
| [`docs/features/requirements.md:167-177`](../../features/requirements.md) | adopter-facing: tying a requirement to a test "is instead the job of a generator that emits the test **from** the requirement" |
| [`spec/capability-ledger.md:234-244`](../../../spec/capability-ledger.md) | `verifiedBy` — RETIRED |
| `agent-context/skills/metaobjects-verify/references/requirements.md:59-64` | agent-facing, **byte-gated** in `agent-context-conformance` |
| [`docs/superpowers/plans/2026-08-21-coordinated-pre-1.0-breaking-batch.md:50`](../plans/2026-08-21-coordinated-pre-1.0-breaking-batch.md) | "a requirement with no test link is a legitimate declared state" |

**So the surface prints no test link at all, and says so.** Silence here is consistent with
five shipped statements rather than a gap in the output. The structural replacement arrives in
§7.

## 4. Shape: an index, plus backlinks — not a page per node

Three shapes were measured. (Token counts from the same external estate; reported, not
reproducible here.)

| shape | output | verdict |
|---|---|---|
| **A** — one index page | 1 file, ~11.9K tokens | **adopt** |
| **B** — page per L1 node | 19 files, ~30.5K tokens, one page at **86KB** | **dominated** — strictly more output, worse to read, worse to diff |
| **C** — backlinks on existing entity pages | ~466 bytes average per page | **adopt** |

**A + C.** The index is the readable whole; the backlinks put the claim where the reader
already is. B is rejected on measurement, not taste — an 86KB page is not a documentation page.

**Shape C is the reason this beats a standalone script.** A hand-rolled registry generator can
produce A. Only something inside the codegen pipeline can add "this entity is claimed by these
requirements" to the entity's own page, because only it holds both halves of the model.

## 5. Two artifacts, both emitted unconditionally

### `requirements.md` — for people

The index. Requirement nodes in ledger order, nesting preserved (hierarchy **is** nesting), each
carrying `@statement`, `@violation`, `@level`, `@status`, `@disposition`, `@trackedBy` and its
resolved `@implementedBy` targets.

`description` is emitted. **`notes` is not**, per
[`documentation.json:15,39`](../../../spec/metamodel/documentation.json) — it is the
internal-only slot, and the whole point of the charter is that a generated user-facing document
honours it without anyone remembering to strip anything.

### `requirements.toon` — for machines

The same data, TOON-encoded. **The reason is the declared-count header, not the token saving.**

Measured with the real `@toon-format/toon` encoder on 321 rows: TOON is **42.1% smaller than
JSON but only 7.3% smaller than a markdown table** — a table is already header-once, so the
compression argument is nearly absent. What TOON adds is:

```
requirements[321]{path,level,status,claims,statement}:
```

A reader can verify it received all 321 rows. That is worth more than 7.3%.

This reuses infrastructure that already exists: `@toon-format/toon` is already a dependency of
`@metaobjectsdev/cli` (`package.json:61`) and `toonEncode` already lives in
[`lib/format.ts`](../../../server/typescript/packages/cli/src/lib/format.ts), which established
the convention at `:17-18` — *"humans at a terminal get text; pipes/agents get TOON."*

**Caveat, stated because it constrains the split:** TOON quotes every comma-bearing string, so
prose dilutes it badly. That is precisely why prose belongs in the markdown and structure
belongs in the TOON, rather than either file trying to be both.

### Why both, unconditionally, rather than a `--format` flag

`meta docs` **writes files**; `--format` on `gen`/`migrate` selects a **stdout** encoding. Reusing
the flag name would make it mean something materially different on this command. And a drift
gate wants the machine-readable artifact committed regardless of who ran the command or from
what kind of terminal.

## 6. The surface contract

`DocsSurface` gains a third member
([`metaobjects-config.ts:195`](../../../server/typescript/packages/codegen-ts/src/metaobjects-config.ts)):

```ts
export type DocsSurface = "model" | "api" | "requirements";
```

plus a `--requirements` CLI flag, narrowing markdown surfaces exactly as `--model` / `--api` do.
`--site` and `--metamodel` are **not** surfaces — they are separate branches in `docs.ts` — so
nothing there changes.

**Three rules govern it:**

1. **Metadata alone.** `meta docs` guarantees it emits *"from metadata **ALONE** — no gen
   config, no codegen pipeline … The neutrality of the output is therefore guaranteed"*
   ([`docs.ts:1-12`](../../../server/typescript/packages/cli/src/commands/docs.ts)). This
   surface introduces **no** new input. That single sentence is what rules out §3's scan, and
   it must keep being true.
2. **An empty ledger emits nothing** — not an empty page. A project declaring no `requirement.*`
   nodes sees no change at all, matching the feature's existing posture (no requirement nodes ⇒
   no diagnostics). This is what makes adding `requirements` to the default surface list safe.
3. **Default on.** `surfaces` defaults to `["model", "api"]` today; it becomes
   `["model", "api", "requirements"]`. Rule 2 is what makes that a no-op for every project
   without a ledger.

## 7. The test link returns structurally — and the generator already ships

**Correction to an earlier reading of this, recorded because it changes the sequencing.**
FR-038 slice 1 is **not** pending: `requirementTests()` is implemented and exported in
TypeScript today
([`generators/requirement-tests.ts`](../../../server/typescript/packages/codegen-ts/src/generators/requirement-tests.ts),
exported from `src/index.ts:204`), built on
[`requirement-walk.ts`](../../../server/typescript/packages/codegen-ts/src/requirement-walk.ts).
The "targeting 1.1" note in the coordinated batch plan scopes *that* plan's work, not the
generator's existence.

It emits `requirements/<requirement dotted path>.<concern>.test.ts`. The link is therefore a
**derived path, not an inference** — no scanning, nothing matched, nothing guessed.

**And the path is metadata-alone-derivable**, since `RequirementView.path` and the concern key
both come from `walkRequirements()`. So rule 1 does *not* block computing it.

**The tension is sharper than "can we compute the path", and it is the reason this still
waits.** `requirementTests()` is **not** in `generator-registry.ts` — a project must wire it
explicitly in `metaobjects.config.ts` (deliberately, per §10's opt-in). So:

- **the path** is a metadata fact — computable here;
- **whether a stub exists at it** is a gen-config fact — *not* computable here.

Rendering a derived path for a project that never wired the generator would assert a file that
does not exist. **That is the same false-assurance failure the scan was rejected for**, relocated
— a document telling a reader a requirement is tested when nothing tests it. So the link stays
gated on knowing the generator ran.

**It is WORSE than the scan in one respect, which is why the gate must not be relaxed.** A
derived path reads as authoritative in a way an author-chosen string never did: a reader who
knows the string was typed by a colleague discounts it, while a path the tool computed carries
the tool's credibility. So a wrong derived link is trusted harder than a wrong authored one.

**The trap for the next reader, stated because it is genuinely inviting:** the path *is*
computable from metadata alone, and computability will look like sufficiency. It is not. The
check keys on **the generator being wired**, never on the path being derivable — and anyone
relaxing it to "we can compute this, so emit it" reintroduces the defect this whole section
exists to prevent.

The precedent for that already exists in the same file: the `api` surface materialises only
with a loadable gen config, *because* api docs describe a generated surface that only exists
when there is one ([`docs.ts:412`](../../../server/typescript/packages/cli/src/commands/docs.ts)):

```ts
const apiSelected = docsCfg.surfaces.includes("api") && loadedConfig !== undefined;
```

A structural test link takes the same shape: **config-gated enrichment on a metadata-alone
surface.** Absent a loadable config, the requirements surface still emits — just without the
link. That keeps rule 1 intact rather than quietly eroding it.

**A stronger form worth preferring if it is cheap:** have the generated stub carry a
machine-readable back-reference to its requirement's FQN. Documentation reading a *generated
artifact's own declaration* is derivation; documentation matching strings in prose is not.

## 8. The spec-citation slot is a separate defect, and A does not dissolve it

A generated index reproduces a citation like `title: "FR-448 — …"` as **inert text**. It renders
it; it does not resolve it. So the citation problem survives this feature.

**But it is better posed as field overloading than as "free text needs a check."** A citation is
living in a node's display label *because there is nowhere else for it to live* — `title` is a
noun phrase, and a citation is not a name. Framed that way it is a candidate for the
[ADR-0037](../../../spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md)
decision procedure, which the "add a check to free text" framing could never pass.

Note the shape of the nearest precedent before proposing vocabulary: `@trackedBy` (0.23.0) is
free-form and **deliberately never resolved**, because `verify` has no network and two systems
holding the same answer will drift. Any citation slot must say why it differs — or reuse
`@trackedBy` and stop there. **Out of scope for this design**; recorded so it is not mistaken
for something this feature delivered.

## 9. Verification

The gate that matters is not "a file was emitted." It is that the emitted view **cannot silently
lose the ledger**, since a documentation generator that quietly drops rows produces a document
that looks complete and is not.

- a **`codegen-conformance` fixture** whose model carries a nested `requirement.*` tree, gating
  both artifacts byte-for-byte — this is the mechanism that keeps A and C in agreement
- the TOON header's declared count **equals** the number of rows emitted, asserted on a fixture
  with nesting (a flat fixture cannot tell a depth-first walk from a top-level-only one)
- a model with **zero** requirement nodes emits **no** requirements file — proving rule 2, which
  is what makes the default-on decision safe
- **`notes` appears in no emitted artifact**, asserted on a fixture where a requirement carries
  both `description` and `notes` — a fixture with only one of them cannot tell suppression from
  absence
- shape C: an entity claimed by a requirement gains its backlink; an unclaimed entity's page is
  **byte-identical** to today's
- **no test link is emitted under any input**, including a model whose requirement names exactly
  match real test files in the repo — the case that would regress §3 silently
- the surface is proven able to fail: sabotage the fixture and watch the lane go red, per this
  repository's standing rule that a gate never demonstrated failing is decorative

## 10. What this does not solve

- **It does not check the prose.** 193 of 403 documents carrying no status line stay that way;
  this generates a parallel view, it does not conscript the existing corpus.
- **It does not prove a requirement is met.** No documentation surface can. The unfakeable
  formulation remains `@violation`-driven mutation, which is out of scope for the same reason it
  is out of scope for `verify`: *"it never runs them"* is byte-gated across five ports.
- **It is TypeScript-only at first.** `meta docs` is a Node-CLI-owned surface. Nothing here
  blocks a per-port equivalent, and nothing here requires one.

## 11. Open questions

- **Where does the requirements index sit relative to `outputLayout`?** The model surface follows
  the project's layout; an index is a single root-level page and may want to ignore it.
- **Does shape C's backlink belong on projections and values, or only on entities?** Object
  coverage is entity-grain today ([`spec/capability-ledger.md:285-296`](../../../spec/capability-ledger.md)),
  which argues for entities only.
- **Does the TOON artifact belong under the docs `outDir` at all**, or beside the metadata? It is
  a machine artifact in a directory otherwise meant for humans.
