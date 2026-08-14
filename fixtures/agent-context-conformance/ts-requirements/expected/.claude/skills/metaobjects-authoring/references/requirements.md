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

**Hierarchy is nesting, and links live at the bottom.** L1 solution, L2 segment, L3
service — these never reference the model. **L4** binds an object, **L5** binds a field,
view or identity. `implementedBy` above L4 is an error. Regrouping *moves* a node; it does
not edit a parent string.

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
