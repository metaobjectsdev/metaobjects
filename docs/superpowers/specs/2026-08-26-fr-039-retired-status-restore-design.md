# FR-039 — Restore a retired-capability status, and fix the defect that removed it

**Status:** proposed · **Date:** 2026-08-26 · **Owner ask:** 2026-08-21 and 2026-08-26 ·
**Reverses:** FR-038 §4, in part — the `@status` half only. `@verifiedBy` stays retired.
**Depends on:** `requirement.*` (0.22.0, 0.23.0, 0.24.0) ·
**Amends:** [`spec/design-docs/2026-08-10-requirements-as-metadata-ruling.md`](../../../spec/design-docs/2026-08-10-requirements-as-metadata-ruling.md)
Amendment 4.

## 1. The claim

`@status` gains one member — **`retired`** — meaning *this capability was built and then
deliberately removed; it must not be rebuilt.* On it, `@implementedBy` is **forbidden**, and
`@supersededBy` returns as a **resolving** reference.

This restores the resurrection guardrail FR-038 removed, and closes — structurally, rather
than by exemption — the defect FR-038 correctly identified.

## 2. Why this is not a matter of taste

The `requirement.*` family exists because of one measurement. Five controlled rounds, 52
agents, pre-registered kill conditions, ruled in
`spec/design-docs/2026-08-10-requirements-as-metadata-ruling.md`. Six claims were tested and
**five were refuted**:

| Claim | Result |
|---|---|
| Requirements stop the LLM rebuilding what exists | Refuted (round 5, n=12) |
| Structured ledger links earn their place over prose | Refuted (11/24 with, 12/24 without) [^r5] |
| The artifact must be ambient | Refuted (read unprompted) |
| Requirements help find dead code | Refuted (grep found 15, best analysis 6) |
| Requirements prevent drift | Refuted (control matched on everything mechanical) |
| **A status field prevents reviving retired features** | **HELD — 0 of 24 without, 19 of 40 with** |

[^r5]: This row read *"Node-side `satisfies:` links earn their place"* as shipped. Both arms
of that comparison carried a ledger and neither carried a node-side link — the variable was
structured list against the same entities in prose. Corrected by Amendment 5 of the ruling;
the claim tested, and refuted, is the one above.

The ruling, §"What survived", line 67: *"The failure prevented is not duplication. It is
**resurrection**."* Line 74: *"A ledger entry with `status: abandoned` does exactly that, in
one line."*

**FR-038 removed the survivor and kept the five that were refuted.** That is the whole of
the case for this FR. Everything below is detail.

## 3. What FR-038 got right, and where the diagnosis slipped

FR-038's empirical finding is real and must not be lost: one estate carried **29
`@implementedBy` references that could never resolve, across 14 entries, while `meta verify`
reported zero dangling references.**

But that silence was **specified, deliberately**, by the ruling FR-038 reversed — §"The
ruling" point 2:

> `implementedBy` is optional, name-checked against the **loaded model**, with severity
> **conditional on status**: a dangling reference on `live`/`partial` is an error (the model
> moved and the ledger is stale); a dangling reference on `abandoned`/`superseded` is
> **allowed**, because those nodes are supposed to be gone — that is the point of the entry.

29 unresolvable references on retired entries is the mechanism working as designed. The
defect is not that the references dangle; it is that **`verify` printed `0` instead of
`29 unresolved on retired entries (expected)`**. Silence and zero are different claims, and
the gate made the wrong one.

So FR-038 answered a **reporting** defect by deleting **vocabulary**. This FR keeps the
finding and fixes it at its own tier — and then goes further than a reporting fix, because a
better structural answer exists (§4).

## 4. The design

### 4.1 `@status: retired`

One new member. `@status` becomes `planned | live | partial | retired`.

*One* member, not two. `superseded` was only ever `retired` plus a pointer, and the pointer
is `@supersededBy` — encoding the pointer's presence in the status duplicated it.

**It is prescriptive, which is what makes it admissible under FR-038's own rule.** FR-038
retired `abandoned` on the principle *"a requirement is prescriptive; it states what should
be true and is never a journal of what happened."* That rule is correct and this FR keeps
it. A `retired` entry states **"this shall not be rebuilt"** — a prohibition, in force,
falsifiable by exactly one observable: its reappearance. The old vocabulary described the
past (`abandoned` — what happened to it); `retired` in this charter describes the standing
rule. That is a real distinction, not a rename to route around the rule.

### 4.2 `@implementedBy` is FORBIDDEN on `retired` — `ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS`

Not exempt. Not warned. Refused at load.

This is the structural fix for §3. A retired capability has no implementation *by
definition*, so the references cannot dangle because they cannot exist. No exemption, no
conditional severity, nothing for a gate to be silent about — the bug class is unreachable
rather than patched.

It also matches what an adopting estate had already done by hand, before any ruling, moving
retirement history out of `@implementedBy` and into `notes` on the reasoning that *"what used
to implement a retired capability is real information in the wrong field."* This codifies a
shape adopters reached on their own.

### 4.3 `@supersededBy` returns, as a resolving reference

Optional, on `retired` only. An FQN reference resolved by the loader like every other, so a
dangling one is an error and the ADR-0042 package-local contract applies by construction.

**The original ruling already asked for this** and never got it — point 4: *"a `supersededBy`
that resolves (FQN-checked, so `verify` can fail on a dangling one), turning 'deleted in S6'
from an inert comment into a build gate."* FR-038 deregistered it as an unresolved string
without ever building the resolving version the ruling specified.

It earns its place on evidence: an adopting estate hit a supersession that was **itself**
superseded — A → B, then B dropped, the live answer a third thing. A prose note points one
hop and goes stale; a resolved reference chains, because B is itself a `retired` entry
carrying its own `@supersededBy`.

### 4.4 Gate behaviour

| | behaviour on `retired` |
|---|---|
| object coverage | never counts — same as `planned`. Retiring a capability must not silence "nothing implements this entity". |
| architectural universality | exempt — a retired policy governs nothing. |
| `@disposition` | not applicable; `WARN_REQUIREMENT_DISPOSITION_NO_GAP` fires as it does on `live`. |
| nesting | unchanged. A `retired` node keeps its level and its place in the tree. |
| doc surface | rendered, and **`meta docs` must emit retired entries** — see §6. |

### 4.5 Why a status member and not a `requirement.prohibition` subtype

A subtype was proposed in review and is rejected on two grounds:

1. **The evidence measured a status field.** The ruling's surviving claim is literally *"a
   status field prevents reviving retired features."* A subtype is a different artifact from
   the one that was tested.
2. **Hierarchy is nesting.** Retiring a capability under a subtype means changing the node's
   *type*, which changes its identity and forces it to move; under a status it is one word,
   and the entry keeps its statement, counterexample, level and position. The thing that was
   proven works precisely because the retired entry sits *where the live one sat*.

A subtype also costs child rules, conformance fixtures and a five-port fan-out for the same
behaviour.

## 5. The honest history, including the argument against this

This has been raised, agreed to, and argued down once already. Recording that fully, because
a reader who finds only half of it will re-litigate the wrong half.

**2026-08-21.** The owner asked for it by name: *"this makes requirements need one that says
retired, as we will actually have code implemented to handle retired."* The point was sharp
and was accepted at the time: the `meta upgrade` retirement map, built four commits earlier,
**is** a journal of what happened — `since` / `why` / `replacedBy` / `migration` — maintained
deliberately and consumed by code. So "a retirement record is inert history" was already
false in this codebase, demonstrated by this codebase.

The design proposed then is the design proposed here: `retired`, with `@implementedBy`
forbidden outright.

**Then it was argued down**, on adopter evidence: an estate reported that `partial` +
`@disposition` loads clean on `0.24.0-rc.5`, and that of 61 retired entries, 42 were dead
history that deleted cleanly and 19 were prescriptive statements legitimately re-filed as
`partial` or `live`. Conclusion drawn at the time: *"this estate needs no `retired` status at
all — the existing taxonomy covers every case once the entries are sorted correctly."*

**That conclusion answers a different question than the one that matters, and the same estate
has since refuted it.** The re-filing exercise asks *can the records be preserved?* — and the
answer is yes. The guardrail asks *does an agent proposing this work get stopped?* Re-filing a
retired capability as `partial` is not neutral on that question; it is **actively harmful**.
`partial` means *this works and here is what is wrong with it* — a statement that the
capability is intended and unfinished. To a retrieval-driven agent that is not an absent
warning, it is **an invitation to finish it**, attached to the near-exact decoy the
measurement was about.

The estate that produced the counter-evidence stated the correction itself on 2026-08-26:

> *"the entries were kept deliberately so an agent wouldn't re-propose retired work… I
> treated it as documentation when its function is **suppression**."*

Data retention and suppression are two functions. FR-038 and the 08-21 reversal both
preserved the first and destroyed the second. Only the second has controlled evidence behind
it.

**No decision was recorded on 08-21.** The thread ended with the reversal surfaced to the
owner and nothing filed. FR-038 shipped that day carrying the retirement.

## 6. What is NOT claimed, and the work this does not do

**The guardrail is 19 of 40 — under half.** It must not be described as more. Restoring the
status buys back a mechanism that fires slightly less than half the time.

**No documented case of prevention exists in production.** An adopter audit looked and found
none. The nearest miss is instructive: in that estate *nothing points an agent at the
ledger* — no rule file, no always-loaded doc, no generated context cites it as a source. A
guardrail nothing routes to, firing at 19/40, is consistent rather than surprising.

**So this FR is necessary and not sufficient.** It should ship with the consumer that makes
the number move:

- `meta docs` **must** emit `retired` entries into the requirements surface (they are the
  entries a reader most needs and the ones a "current state" doc would naturally omit);
- the scaffolded agent context should route an agent to the ledger before proposing new
  capability work.

Whether that second piece raises 19/40 is **measurable and unmeasured**. It is the natural
re-run of round 5 and should be run rather than asserted.

## 7. Migration and versioning

**Additive. Nothing that loads today stops loading.** `planned | live | partial` keep their
meanings and their gates.

| axis | value |
|---|---|
| package version | **PATCH** — npm/PyPI/NuGet `0.24.2`, Maven `7.24.2`. See below. |
| `metamodelVersion` | **`0.12` → `0.13`** — its own axis, and it moving does NOT force a package minor (ADR-0035 Amendment 2). |
| ports | all five; `expected-registry.json` is byte-gated, plus `registry-conformance` and negative fixtures for §4.2 |
| adopter action | **none required.** An estate on `planned/live/partial` is untouched. |

**`meta upgrade` gains an automatic path it could not have before.** It currently *refuses*
`@status: abandoned` and exits non-zero, because deciding a retired capability's fate was
judgment. With `retired` registered the edit becomes determinate — `abandoned` → `retired`,
`superseded` → `retired` + `@supersededBy`, dropping `@implementedBy` — so the one case the
0.24.0 migration could not automate becomes mechanical. That is a direct argument for this
shape over any alternative.

**Why PATCH, and why the two version axes must not be read off each other.** ADR-0035
Amendment 1 sorts vocabulary by CONSUMER IMPACT: **attribute ⇒ PATCH**, top-level type ⇒
MINOR, subtype ⇒ PATCH when inert. This adds one enum member to an existing attribute and one
attribute — both the PATCH tier. Nothing that loads on `0.24.x` stops loading, and no adopter
must edit anything.

The trap worth naming, because a first pass through this fell into it: the
`check-metamodel-version` gate reports **"required bump: minor"**, and that is a statement
about **`metamodelVersion`**, not about the package. They are separate contracts — the whole
point of Amendment 2 — and reading the package version off the metamodel gate is exactly the
conflation it exists to prevent.

**And the caret rule decides it, not just permits it.** `^0.24.x` resolves a patch, so an
estate carrying the retired vocabulary picks the repair up on a routine `npm update`;
`0.25.0` would strand it behind a deliberate bump. That is the `0.21.5` lesson stated in
that release's own changelog — **a MINOR cannot reach the adopters a bug has already
broken** — and it applies with more force here, because the estate this FR exists for is
broken by `0.24.0` right now.

**1.0 readiness.** `metamodelVersion` moves, and `docs/1.0-readiness.md` §G3's standing
recommendation was one more coordinated release with no such move. **RULED (2026-08-26):
this does NOT reset the clock and IS the quiet release** — recorded in the G3 bullet itself,
per that document's own instruction, on the reasoning that G3 measures BREAKING churn and
this forces zero adopter edits where `0.24.1` forced some.

## 8. Open questions

1. **`@retiredIn`?** The 08-21 sketch mapped the retirement map's `since` onto an
   `@retiredIn` attribute. Left out here deliberately: version control dates the change and
   `notes` carries the why. Add it only if an adopter demonstrates the date is needed by a
   consumer, per the ADR-0007 Amendment 2 bar.
2. **Does `verify` also need the reporting fix from §3?** With §4.2 forbidding
   `@implementedBy` there is nothing left to under-report on `retired`. But the general
   lesson — *a gate that prints `0` when it means "not checked" is making a false claim* —
   may apply elsewhere and is worth a sweep.
3. **Should a `retired` entry's `@counterexample` be re-charted as the revival signature?**
   On a live requirement it describes a violation; on a retired one the violation *is* the
   rebuild. Same slot, and adopters already author it that way — but the registry prose
   should say so.

## 9. Process note — this is the second time on this file

`spec/design-docs/2026-08-10-requirements-as-metadata-ruling.md` Amendment 3 records an owner
decision that *"was recorded as a documentation amendment and an issue written as the
opposite of what was approved — and an implementation was then built against the issue."*

The same shape recurred here: a committed ruling set a re-open bar (*"Re-open only with
genuinely new information"*), FR-038 reversed the ruling's central finding without clearing
that bar and without amending the ruling, and the ruling still describes the retired
vocabulary as current on `main` today.

The durable rule this suggests, offered for an ADR rather than asserted as one: **a committed
ruling is reversed by amending it, in the same file, and a re-open bar is a precondition
rather than a formality.** A design document that reverses a ruling without touching it
leaves two contradictory shipped statements — which is the exact failure FR-038 itself was
written to resolve.
