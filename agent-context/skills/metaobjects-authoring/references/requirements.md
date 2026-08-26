# Requirements — `requirement.functional` / `requirement.architectural`

Capabilities are **metadata**, declared in `metaobjects/` beside the entities they
describe. Read the existing requirement nodes before designing anything. Two rules matter
more than the rest.

**1. A requirement is PRESCRIPTIVE — it states what should be true, never what happened.**
`status` is `planned | live | partial | retired`, and every one of them states something
meant to be true. `retired` is not the exception: it means **"this was built, then
deliberately removed, and must not be rebuilt"** — a prohibition in force, falsifiable by
exactly one observable, the capability reappearing.

So write a retired entry as a rule, not a diary. `statement: "An unpaid order is never
expired by a wall-clock timer"` is a prohibition; `"We used to expire orders on a timer"` is
history wearing a requirement's shape, and no gate will catch it. On a retired entry
`counterexample` describes **the revival** — the thing a future reader is about to propose.

**Do not delete a retired capability's entry.** Keeping it is the single most load-bearing
thing this vocabulary does: given a brief for a capability that had been retired, agents
working from the model alone proposed rebuilding it 24 times out of 24. The entry is what
stops that, so a retirement is a status change plus a rewritten statement, never a deletion.

Three rules the loader enforces on `retired`:

- **`implementedBy` is REFUSED** — a retired capability has no implementation by definition.
  What used to implement it goes in `notes`. If deleting the references feels wrong, the
  capability is probably not retired: an entry whose nodes are still there is `live` or
  `partial`.
- **`supersededBy` names the requirement that replaced it**, legal here only, and RESOLVED —
  so the chain still works when the replacement is itself retired later.
- It never counts toward object coverage, and is exempt from the architectural universality
  check.

Leaving a dangling `implementedBy` is **correct only on `planned`**: the entry precedes the
nodes. On `live` or `partial` the same dangling reference is an error — the model moved and
the requirement went stale.

**2. When you add an entity, claim it.** Every `object.entity` should appear in some
requirement's `implementedBy`, or `verify` says so.

**Every requirement states its counterexample.** One sentence: what breaking it looks like.
*"Every entity has a uuid primary key"* is violable — point at one with a composite string
key. *"Things are persisted"* is not, and is a description rather than a requirement. Same
rule kills *"the system is reliable"*. If you cannot say what breaking it looks like,
delete it.

**Four prose slots, and `statement` is the one that means "description".** A requirement can
also carry the common `description` and `notes`, and they overlap badly unless you decide the
split before writing any of them:

- `statement` — **the claim**. This IS the description of what the requirement is
- `counterexample` — **what would falsify the claim**, which is what makes it checkable
- `description` — **the scope**: what the claim covers, what it deliberately does not, and
  which sibling entry owns the rest
- `notes` — **the evidence**: how you know the `status` is true — citations, vocabularies, the
  control you ran to prove an absence was real

**`title` is a LABEL and is chartered here; `summary` is not.** A requirement's `name` is an
identifier and its address renders as a dotted camelCase path, so a short noun-phrase `title` is
what an index shows — the requirement attribute table in `spec/capability-ledger.md` says so by
name, and the generated requirements page renders it in the heading after the path
(`## checkout.payment — Payment capture`). `summary` is different: `statement` is already the
required one-line sentence, so a `summary` can only repeat it and nothing reads it (`verify` warns,
`WARN_REQUIREMENT_INERT_DOC_SLOT`). `notes` is unrendered on purpose — chartered internal-only.

**Never put a catalogue or ticket id in `title`.** A title is a noun phrase; an id is not a name.
`title: "FR-467 — Order recording"` is two things in one slot — put the id in `trackedBy` and
keep the phrase as the title. `verify` warns (`WARN_REQUIREMENT_TITLE_IS_AN_ID`).

**The `name` is an address, so write it as an identifier.** It is the segment of the dotted
path (`Ordering.Placement.Recorded`) and the filename of the generated test stub. A `.` in a
name is indistinguishable from nesting — `Orders.Recorded` and `Orders` containing `Recorded`
produce the same path — and a sentence for a name puts the claim somewhere nothing reads it.
Both load; `verify` warns (`WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE`,
`WARN_REQUIREMENT_NAME_READS_AS_PROSE`, `WARN_REQUIREMENT_NAME_RESTATES_STATEMENT`).

Two failure modes, both of which look like diligence. A `description` that **paraphrases the
statement** is padding, and it makes every later reader trust the ledger less — leave it off
instead, it is optional. A `description` that **narrates the evidence** belongs in `notes`;
the tell is a fact you had to read the implementation to learn. Mechanical test for the last
line: *would this sentence have to change if the code changed but the model did not?* Then it
is `notes`. `verify` warns on the exact repeats (`WARN_REQUIREMENT_PROSE_DUPLICATED`), and on
a `statement` or `counterexample` that is present but blank (`WARN_REQUIREMENT_PROSE_EMPTY`) —
the loader requires those attrs to exist, never to say anything.

**Hierarchy is nesting, and links live at the bottom.** L1 solution, L2 segment, L3
service — these never reference the model. **L4** binds a declared top-level node — an
`object.*` **or a `template.*`** — and **L5** binds a member of one: a field, view,
validator, identity, or a template's child. `implementedBy` above L4 is an error.
Regrouping *moves* a node; it does not edit a parent string.

**Write an L5 ref as a dotted `pkg::Owner.member` path** — the level and the shape of the
ref must agree, and this is the single easiest thing to get wrong:

```yaml
# L4 binds the OBJECT
level: 4
implementedBy: ["acme::orders::Order"]

# L5 binds ONE MEMBER of it — dotted owner.member, not the object
level: 5
implementedBy: ["acme::orders::Order.placedAt"]
```

Both mismatches are caught and they are symmetric: an L5 whose ref names an object is
`ERR_REQUIREMENT_L5_NOT_MEMBER`, an L4 whose ref names a member is
`ERR_REQUIREMENT_L4_NOT_OBJECT`. **In both cases the fix is to move the entry to the other
level, not to rewrite the ref** — the ref is usually right and the level is usually the
mistake. The instinct that produces the error is reaching for the object a rule is *about*;
what L5 wants is the member the rule is *carried by*. Copying an L4 block and changing only
`level: 5` produces exactly this failure.

Reach for L5 when the statement is about ONE column and its entity's own requirement could
not express it — "this lifecycle is `resolvedAt IS NULL` and never `status`", "this id is
nullable, which is why the parent is `partial`". Do NOT use L5 for a blanket rule that
happens to touch many fields; that is an architectural requirement.

Claim your prompts. A `template.prompt` is a model node realising a capability exactly as
an entity is, and it is the node whose retirement is hardest to see later — a removed
prompt leaves no table behind. A prompt estate with no requirement entries is the same
blind spot this whole mechanism exists to close.

**L1–L3 are levels of abstraction and ownership in the problem domain** — whose need is
this, and at what altitude — and are NEVER a directory, package, deployable or module.
Technical constructs appear only at L4/L5, which is the allocation step. Test every node:
*if a refactor that changes no behaviour would force it to move, its level is wrong.*

**Architectural requirements are the other kind.** `requirement.architectural` is flat by
default — a uuid-PK rule, change attribution, tenant scoping. Its check is *universality*
rather than existence, so one that is `live` and claimed by nothing fails: a policy
declared and applied to nothing. A `@level` is OPTIONAL here and opts the node into a tree
(for organising non-functional requirements under a quality taxonomy); once levelled, the
same nesting and link-floor rules apply as to a functional node.

`@status` is a closed enum enforced by the loader, so a typo fails the load rather than
silently disabling the entry.

**Record gaps rather than rounding them off.** `partial` says *this works and here is what
is wrong with it*, and it is the most useful status in the enum — a ledger with none is
usually one nobody read carefully. Then say what was DECIDED, which is a separate question:

- `@disposition: accepted` — understood, deliberately not being closed
- `@disposition: deferred` — will be closed, not now (name a ticket in `@trackedBy`, or
  `verify` warns; deferring without one is how a known problem becomes an unknown one)
- **absent** — undecided, and that is a real state. `verify` counts these, because
  *"which gaps has nobody ruled on?"* is the question a review exists to answer.

A `partial` nobody intends to finish is `partial` + `@disposition: accepted` — the gap is
understood and deliberately not being closed. If the capability itself is gone, delete the
requirement instead.

**`status: planned` locks in work you have not started.** Its references may dangle (write
the requirement before the entity), and it never counts toward object coverage — otherwise
declaring an intention would clear the unclaimed-entity warning and the gate would measure
ambition rather than work.

```yaml
- requirement.functional:
    name: Pacing
    level: 3
    status: live
    statement: "Scene pacing follows story beats"
    counterexample: "A scene that advances on a clock rather than on the story"
    children:
      - requirement.functional:
          name: BeatProgression
          level: 4
          status: planned            # not built yet -- refs may dangle
          statement: "A scene advances when its beat completes"
          counterexample: "A scene that advances with its beat unresolved"
          trackedBy: ["acme/game#412"]
          implementedBy: ["game::turn::BeatProgression"]   # does not exist YET

- requirement.architectural:
    name: UuidPrimaryKeys
    status: live
    statement: "Every entity has a uuid primary key"
    counterexample: "An entity keyed by a composite string"
    implementedBy: ["game::turn::Turn", "game::world::Location"]
```

There is **no `satisfies:` on a field or entity** — links live on the requirement node, not
on the nodes it claims. Full reference: the repo's `spec/capability-ledger.md`.
