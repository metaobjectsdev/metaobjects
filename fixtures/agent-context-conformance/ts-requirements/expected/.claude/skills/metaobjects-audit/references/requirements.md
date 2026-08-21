# Requirements — the audit dimension

This project declares `requirement.*` nodes, so the ledger is an auditable surface. Audit it
for **truthfulness**, not volume. A large ledger that lies is worse than a small one that
does not, because every later reader trusts it.

Run `meta verify` first. It settles referential integrity mechanically — do not spend audit
effort re-deriving what a green run already proves.

## What verify has already proven (do not re-check by hand)

Links sit at or below the L4 floor, nesting agrees with levels, `@status` values are legal,
and references resolve (with dangling allowed on `planned`, whose nodes do not exist yet).

## What only a human or an agent reading the code can catch

**1. Statuses that are false.** The highest-value finding in the whole dimension. A
requirement marked `live` whose implementation was gutted; one marked `partial` that is now
complete; one marked `planned` that was quietly built months ago. Sample the claims
and read the nodes. `status` is the only payload with controlled evidence behind it — the
resurrection protection rides entirely on it being true.

**2. Non-violable statements.** Every requirement must state what breaking it looks like.
*"Every entity has a uuid primary key"* is violable — point at one with a composite key.
*"Things are persisted"* is not; it is a description wearing a requirement's shape. Flag
these: they inflate the ledger while proving nothing.

**3. Claim-padding.** An entity appended to an existing unrelated requirement's
`implementedBy` purely to silence the coverage warning. The claim resolves, so verify is
happy, but it carries no information about what the entity is *for*. Look for entities whose
only claim is a high-fan-out architectural rule when they plainly have product meaning.

**4. Misfiled kind.** `functional` is checked by EXISTENCE, `architectural` by UNIVERSALITY —
opposite polarity, and nothing mechanical catches a misfile. The discriminator: did this
exist because someone asked for something (functional), or because every entity here looks
like this (architectural)? An architectural entry with one claimant is usually a misfiled
functional one.

**5. Levels used as decoration.** L1–L3 are organisational and must never reference the
model. If the tree is flat, or every entry is L3, the levels are carrying no information and
should be simplified rather than defended.

## Scope — do NOT flag these as defects

- **Unclaimed `object.value` / `object.projection`.** Exempt by design: a value is a shape, a
  projection derives from a claimable entity.
- **Fields, views, validators and identities without their own requirement.** Member-grain
  coverage is explicitly rejected — plumbing members are covered by architectural
  requirements with high fan-out. L5 exists so a member claim *can* be made where it means
  something, never so every member must carry one.
- **Dangling links on `planned`.** Correct — the plan precedes the nodes.
- **A project with no requirements at all.** The feature is opt-in by declaration; absence is
  not a finding.

## Reporting

Report findings as claims to verify, not as a score. "These 4 requirements are marked `live`
and I could not find their implementation" is actionable; "ledger maturity: 62%" is not, and
invites optimising the number.
