# `api-contract-conformance/enum-default/` — an enum `@default` applies on create

Cross-port REST contract for a `field.enum` that declares `@default`: when a create request
omits the field, the generated create handler stores the default, and a value the body does
supply is kept.

The model is one `Ticket` whose `priority` is an enum of `LOW`, `NORMAL`, `HIGH` with
`@default: "NORMAL"`.

## The contract

- **An omitted defaulted enum takes its default on create.** `POST /api/tickets` with no
  `priority` answers `201` and the echoed row carries `priority: "NORMAL"`; a `GET` by id then
  returns the same value, so the default was stored and not only echoed.
- **A supplied member is kept.** A body with `priority: "HIGH"` answers with `HIGH`, so a port
  that always writes the default fails.

## What each port's lane provisions

A port's generated create either writes the default itself (Java fills the absent field before it
binds the DTO; Kotlin's data class defaults it) or omits the column from the INSERT and lets the
store apply it (TypeScript, C# and Python). A lane of the second kind provisions the `priority`
column with the `DEFAULT 'NORMAL'` that `meta migrate` emits for an enum `@default`, so every
lane runs the model against the schema the project's own migration would produce.

## Files

```
enum-default/
├── README.md
├── meta.json                         # Ticket (tickets table)
├── seed.json                         # two rows, priorities HIGH and LOW
└── scenarios/
    ├── create-omitted-takes-default.yaml    # POST without priority, then GET by id
    └── create-supplied-kept.yaml            # POST with priority HIGH, then GET by id
```

Generated lane only: what is under test is whether each port's GENERATOR emits a create
handler that applies the default, which a hand-rolled reference server would satisfy by
construction.
