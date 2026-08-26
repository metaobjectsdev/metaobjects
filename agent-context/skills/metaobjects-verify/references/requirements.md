# Requirements — what `meta verify` checks

This project declares `requirement.*` nodes, so `verify` checks them. **There is no
subverb**: requirements are metadata, so they are checked on *every* `meta verify` run.

## The split, and why it matters when you read a failure

| | owns |
|---|---|
| **loader** | `@status` enum, required attrs, child rules, levels — unconditional |
| **`verify`** | `@implementedBy` resolution — **severity depends on `@status`** |

A typo'd `@status` fails the **load** ("failed to load metadata"), before verify runs. If you
see that, no other diagnostic in the run is trustworthy — fix it first and re-run.

## A load failure on RETIRED vocabulary — run `meta upgrade`, do not hand-sweep

`@status` is not the only way the load fails before any of this runs. **0.24.0** retired
`@violation` (→ `@counterexample`), `@verifiedBy`, `@supersededBy` and the `abandoned` /
`superseded` members of `@status`; **0.24.1** made an index key `@fields` **XOR** `@expr`, so a
node declaring both is now `ERR_INVALID_INDEX`. There is no deprecation shim for any of them —
the registry is sealed (ADR-0023), so a legacy document does not load at all and every check on
this page is unreachable until it does.

```
meta upgrade            # previews every rewrite; writes nothing
meta upgrade --apply    # makes them
```

It rewrites from the same table the loader's error text is generated from, so the fix you are
told about and the edit the tool makes cannot drift apart. It fixes only what has one correct
answer and **refuses the rest, exiting non-zero** — a partial migration can never be recorded
as finished by CI. Two refusals are expected on a real ledger and both are yours to decide:

- **`@status: abandoned` / `superseded`.** What happens to a retired capability's record is a
  judgement nobody wrote down. Under FR-038 a requirement is prescriptive — it states what
  should be true and is never a journal — so the entry is normally **deleted** (version control
  holds that it existed) with anything a future reader still needs moved to `notes` on the
  surviving entry.
- **`origin.collection`.** Retired to `origin.aggregate @agg: collect`; the attribute sets
  differ, so the tool will not guess.

`@fields` beside `@expr` **is** rewritten, and the survivor is not a coin toss: that pair loaded
before 0.24.1 with `@fields` silently discarded, so the index already in your database is the
expression one. `upgrade` drops `@fields` — which reproduces the object that exists and emits no
DDL change. Do not hand-pick the other survivor; that invents a new index and migrates live data.

## The status asymmetry — the one that surprises people

The **same** unresolved `@implementedBy` reference is:

- an **error** on `live` / `partial` — the model moved and the requirement is stale;
- **allowed** on `planned` — those nodes do not exist YET. That is
  the entry doing its job, not drift.

So on a `planned` entry a dangling reference is the entry doing its job, not drift — do not
"fix" it by deleting the reference, or you delete the plan.

## Exit codes

| situation | exit |
|---|---|
| clean tree, or no `requirement.*` nodes at all | 0 |
| dangling `@implementedBy` on `live`/`partial` | 1 |
| the same reference on `planned` | 0 |
| `@implementedBy` above the L4 link floor | 1 |
| live `requirement.architectural` claimed by nothing | 1 |
| an entity no requirement claims | 0 (warning) |

## The error codes, and the fix for each

Match on the stable `code`, never the message text (ADR-0009). The runtime messages already
name the remedy; this table exists so you can act on one without re-deriving the rule.

| code | what it means | fix |
|---|---|---|
| `ERR_REQUIREMENT_DANGLING_REF` | an `@implementedBy` ref does not resolve in the loaded model, on a status that requires live nodes | the model moved and the claim is stale — repoint the ref, or change the status if the capability really went away. **Check the ref is not merely unloaded**: a source missing from `sources` makes a live node look deleted. |
| `ERR_REQUIREMENT_L5_NOT_MEMBER` | an L5 entry's ref names an OBJECT | move the entry to **L4**, or repoint to a member as `pkg::Owner.member`. Moving the level is usually right — the ref is usually what you meant. |
| `ERR_REQUIREMENT_L4_NOT_OBJECT` | an L4 entry's ref names a MEMBER | the symmetric case — move the entry to **L5**, or repoint at the owning object. |
| `ERR_REQUIREMENT_LINK_ABOVE_FLOOR` | `@implementedBy` on an L1–L3 node | L1–L3 are problem-domain altitude and never reference the model. Push the claim down to the L4/L5 child that actually carries it. |
| `ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS` | a `live`/`partial` `requirement.architectural` that nothing implements | a policy declared and applied to nothing. Claim the nodes it governs, or drop it to `planned` — which is exempt, because it is not applied yet by definition. |
| `ERR_REQUIREMENT_LEVEL_NESTING` | a node's `@level` disagrees with the level of the parent it nests under | nesting IS the hierarchy. Move the node to the right parent rather than editing the level to match where it happens to sit. |
| `ERR_REQUIREMENT_BAD_LEVEL` | `@level` is not an integer inside the allowed range | levels are L1–L5 and nothing else. |
| `ERR_MISSING_REQUIRED_ATTR` | a required attr is absent | `@statement`, `@status` and `@counterexample` are required on both subtypes; `@level` is required on `functional` and optional on `architectural`. |
| `ERR_BAD_ATTR_VALUE` | a closed-enum attr has an unknown value | `@status` and `@disposition` are enforced by the LOADER, so a typo fails the load in every port rather than passing in some. |

**A note on the L4/L5 pair.** They are enforced at the same site and fail for opposite
reasons, so reading only the code you hit can send you the wrong way. The question is not
"is this ref valid?" — usually it is — but "does the LEVEL match the shape of the ref?"

## The authoring lint — a second section, never an error

`verify` also prints an **authoring lint** under its own heading, after the gate's own
warnings:

```
meta verify — requirements: 6 authoring warning(s) (advisory — does not fail the build):
```

Read it as a different claim from everything above. The gate says the ledger **disagrees with
the model**; the lint says it agrees but **records less than its author thinks**. Every finding
is a warning and none can change the exit code, so a lint-only run is a passing run.

| code | what it means | fix |
|---|---|---|
| `WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE` | the `name` holds a character that breaks the dotted path or the generated stub filename | rename it. A `.` is the common one and the worst: `Orders.Recorded` and `Orders` containing `Recorded` produce the **same** path, so the address stops identifying one node. |
| `WARN_REQUIREMENT_NAME_READS_AS_PROSE` | the `name` is a sentence | the name is an address — make it an identifier and put the prose in `@statement`. |
| `WARN_REQUIREMENT_NAME_RESTATES_STATEMENT` | `name` and `@statement` say the same thing | the claim is written twice. Keep `@statement` (every surface reads it) and shorten the name. |
| `WARN_REQUIREMENT_PROSE_EMPTY` | `@statement` or `@counterexample` is present but blank | the loader requires the attr to EXIST, never to say anything. Write the sentence, or delete the entry. |
| `WARN_REQUIREMENT_PROSE_DUPLICATED` | `description` repeats `@statement` (whole, or as its opening sentence), or `@counterexample` does | `@statement` is already the description. `description` holds the SCOPE; drop it entirely if the scope is obvious. |
| `WARN_REQUIREMENT_INERT_DOC_SLOT` | `summary` is set on a requirement | `@statement` is already the required one-line sentence, so a summary can only repeat it, and nothing reads it. Delete it. (`title` is NOT flagged — it is chartered as the entry's label.) |
| `WARN_REQUIREMENT_TITLE_IS_AN_ID` | `title` holds a catalogue or ticket id | a title is a noun phrase and an id is not a name. **Split** it — the id to `@trackedBy`, the phrase stays the title. Do not move the whole string; that throws the label away. |

Findings from both sections are addressed by the requirement's **dotted path**, never its
bare name — two branches of a ledger may reuse a name, so a bare one can be ambiguous.

Mute the lint with `--no-requirement-lint` or `META_NO_REQUIREMENT_LINT=1`. That silences the
advisory half **only** — the gate above still runs and can still exit 1.

Two deliberate silences. The lint reports only **exact** repeats, never a paraphrase — a
similarity threshold on prose produces findings you can argue with. And it never judges
whether a statement is true or a counterexample sufficient; those are the judgements the
ledger exists to record.

## `verify` does not look at your tests

It used to. `@verifiedBy` asked you to name a test, and `verify` checked that the **name**
occurred somewhere in your test sources. That is existence evidence, never proof — an audit of
one real 19-name ledger opened every named test and found **4 that did not verify their
claim**: one matched a comment, one a dependency-injection key, one a real test of a
*different* claim, and one a test of the entry's output where the claim was about its source
text. `verify` reported zero errors throughout. The author picks the string, so the cheapest
way to satisfy the check is to find any name that already exists.

The attribute is retired. Tying a requirement to a test is the job of a generator that emits
the test **from** the requirement, so the link is structural rather than a name someone chose.

## What a green run does NOT prove

It proves **referential integrity**: statuses parse, levels are in range, links sit at or
below the floor, references resolve.

It cannot prove a status is **true**, or that a node genuinely implements the requirement
claiming it. No test can. That judgement is yours.

Coverage is also narrower than the name suggests: it is checked at **entity grain only** —
`object.value` and `object.projection` are exempt, and fields, views, validators and
identities are never required to be claimed. Green means "every entity is claimed by
something", not "every node is described".

Full reference: the repo's `spec/capability-ledger.md`.
