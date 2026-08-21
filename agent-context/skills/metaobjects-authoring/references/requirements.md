# Requirements — `requirement.functional` / `requirement.architectural`

Capabilities are **metadata**, declared in `metaobjects/` beside the entities they
describe. Read the existing requirement nodes before designing anything. Two rules matter
more than the rest.

**1. When you retire something, record it — at that moment.** Set the requirement's
`status` to `abandoned` (built, then deliberately dropped) or `superseded` (something else
does it now — name it in `supersededBy`), in the same change that removes the code.

This is the one thing a requirement does that the rest of the model cannot. Given a brief
matching a retired feature, agents reading only the model proposed **reviving** it 24 times
out of 24, each believing it was reusing. A retired feature is *more* attractive than a
live one: purpose-built for exactly the request, never complicated by production.

Leaving a dangling `implementedBy` on an `abandoned` or `superseded` requirement is
**correct** — those nodes are supposed to be gone, and `verify` allows it deliberately. On
`live` or `partial` the same dangling reference is an error: the model moved and the
requirement went stale.

**2. When you add an entity, claim it.** Every `object.entity` should appear in some
requirement's `implementedBy`, or `verify` says so.

**Every requirement states its violation.** One sentence: what breaking it looks like.
*"Every entity has a uuid primary key"* is violable — point at one with a composite string
key. *"Things are persisted"* is not, and is a description rather than a requirement. Same
rule kills *"the system is reliable"*. If you cannot say what breaking it looks like,
delete it.

**Four prose slots, and `statement` is the one that means "description".** A requirement can
also carry the common `title`, `description` and `notes`, and they overlap badly unless you
decide the split before writing any of them:

- `title` — a short **noun-phrase** label (`name` is an identifier; this is what an index shows)
- `statement` — **the claim**. This IS the description of what the requirement is
- `violation` — **the counterexample** that makes the claim checkable
- `description` — **the scope**: what the claim covers, what it deliberately does not, and
  which sibling entry owns the rest
- `notes` — **the evidence**: how you know the `status` is true — citations, vocabularies, the
  control you ran to prove an absence was real

Two failure modes, both of which look like diligence. A `description` that **paraphrases the
statement** is padding, and it makes every later reader trust the ledger less — leave it off
instead, it is optional. A `description` that **narrates the evidence** belongs in `notes`;
the tell is a fact you had to read the implementation to learn. Mechanical test for the last
line: *would this sentence have to change if the code changed but the model did not?* Then it
is `notes`.

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

A `partial` nobody intends to finish is usually `abandoned` — built then deliberately
retired, the one status where a dangling reference is correct.

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
    violation: "A scene that advances on a clock rather than on the story"
    children:
      - requirement.functional:
          name: TurnTimer
          level: 4
          status: abandoned          # retired deliberately -- do NOT revive
          statement: "Pacing was driven by a per-turn wall-clock timer"
          violation: "Pacing driven by elapsed time instead of beat completion"
          supersededBy: BeatProgression
          implementedBy: ["game::turn::TurnTimer"]   # gone, and that is the point

- requirement.architectural:
    name: UuidPrimaryKeys
    status: live
    statement: "Every entity has a uuid primary key"
    violation: "An entity keyed by a composite string"
    implementedBy: ["game::turn::Turn", "game::world::Location"]
```

There is **no `satisfies:` on a field or entity** — links live on the requirement node, not
on the nodes it claims. Full reference: the repo's `spec/capability-ledger.md`.
