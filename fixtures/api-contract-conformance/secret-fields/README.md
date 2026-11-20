# `api-contract-conformance/secret-fields/` — #484 credentials and excluded fields

Cross-port REST contract for the fields a generated API must not expose or accept: a
field excluded from forms (`@formExclude`), a credential (a field that declares a
`view.password`) and a server-owned `@mutability: readOnly` field.

The model is one `Account`:

| Field       | Marked                      | Generated write routes | Generated read routes |
|-------------|-----------------------------|------------------------|-----------------------|
| `name`      | (nothing)                   | accepted               | returned              |
| `tokenHash` | `@formExclude: true`        | **ignored**            | returned              |
| `pinHash`   | child `view.password`, `@filterable`, `@sortable` | **ignored** | **never returned**, never filterable or sortable |
| `role`      | `@mutability: readOnly`     | **ignored**            | returned              |

## The contract

- **A `@formExclude` or credential field is not writable through create, PATCH or PUT.** The
  value is ignored, not rejected: the request answers as if the key were absent. That is the rule
  for every key outside the settable set (`@mutability: writeOnce` on PATCH, the TPH discriminator,
  `@autoSet: onCreate`), and it is load-bearing here too: a generated edit form submits every
  field it was given, so a `400` on a present key would fail every save.
- **A present `null` is a write**, so it does not reach a denied column either.
- **A credential is never returned**: not by list, not by get, not in the echo of a create or
  an update. The key is absent from the object, not `null`.
- **Redaction does not depend on the host's JSON naming.** The credential is absent whatever key
  the host's serializer would give it: a snake or kebab naming strategy or policy (`pin_hash`,
  `pin-hash`), a rename, a mixin. Each port reads the key from its serializer's own contract
  rather than spelling the field name, and refuses a response it cannot strip instead of
  sending it. The Java and Kotlin generated lanes drive the corpus's reads under no naming
  strategy, `SNAKE_CASE` and `KEBAB_CASE`.
- **A `readOnly` field is ignored on every write the same way**, and returned like any other
  field: the server owns its value (here, the seeded `role`), so a create leaves it `null`.
- **A credential is never filterable or sortable**, even when the model marks it `@filterable` or
  `@sortable`: a filter on a secret is an oracle for it, and its order leaks it. The allowlists are built
  without it, so a request that names it is refused with the same envelope as any other field they do not
  hold (`invalid_filter_field`, `invalid_sort`). `pinHash` carries both marks in this model to prove it.
- **A credential on one subtype of a single-table (TPH) hierarchy is a credential for the whole
  table.** The subtypes share one physical column, so a filter or sort on it is an oracle for the
  secret whichever subtype is addressed. The allowlists of the base and of every subtype are built
  without it, whichever subtype is declared first. `tph/` pins this: `approver` is a plain
  `@filterable`, `@sortable` column on `CouponAuth` and a `view.password` on `PermitAuth`, and a
  filter or sort naming it is a 400 on the base route and on both subtypes' routes.
- **`@formExclude` alone does not hide a field.** It says how the field is written, and the
  field is still part of the resource.
- The application still writes these fields through its own code (the generated queries, the
  repository, the ORM). Only the generated HTTP boundary refuses them.

## How `pinHash`'s write is asserted

A credential is never read, so no scenario can observe over HTTP whether a write reached it.
Instead, each port's runner reads the stored rows back after `write-ignores-excluded` (from the
database, or from the in-memory repository behind the generated controller): the seeded rows
still hold their seeded `tokenHash` and `pinHash`, and the created row holds `null` in both.

## Files

```
secret-fields/
├── README.md
├── meta.json                         # Account (accounts table)
├── seed.json                         # two rows, both secrets set
└── scenarios/
    ├── read-omits-credential.yaml    # GET by id and list: pinHash absent, tokenHash present
    ├── filter-sort-refuses-credential.yaml  # filter or sort on pinHash (marked @filterable, @sortable) is a 400
    └── write-ignores-excluded.yaml   # POST / PATCH / PUT / present-null leave tokenHash and the readOnly role alone
secret-fields/tph/                    # the TPH sibling-credential case (the tph/ corpus's Auth hierarchy, one shared column marked)
├── meta.json                         # Auth + Bridge/Coupon/Permit; `approver` plain on CouponAuth, credential on PermitAuth
├── seed.json                         # the tph/ corpus's three rows
└── scenarios/
    └── tph-sibling-credential.yaml   # filter or sort on approver is a 400 on the base, coupon and permit routes
```

`tph/` runs through each port's TPH generated-lane harness (the same one as the `tph/` corpus, pointed at
this model); every other scenario runs through the Account harness. Generated lane only: what is under test is whether each port's GENERATOR emits routes that
honour the marks, which a hand-rolled reference server would satisfy by construction.
