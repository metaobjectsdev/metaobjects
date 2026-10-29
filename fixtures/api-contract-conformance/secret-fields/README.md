# `api-contract-conformance/secret-fields/` — #484 credentials and excluded fields

Cross-port REST contract for the fields a generated API must not expose or accept: a
field excluded from forms (`@formExclude`) and a credential (a field that declares a
`view.password`).

The model is one `Account`:

| Field       | Marked                      | Generated write routes | Generated read routes |
|-------------|-----------------------------|------------------------|-----------------------|
| `name`      | (nothing)                   | accepted               | returned              |
| `tokenHash` | `@formExclude: true`        | **ignored**            | returned              |
| `pinHash`   | child `view.password`       | **ignored**            | **never returned**    |

## The contract

- **A `@formExclude` or credential field is not writable through create, PATCH or PUT.** The
  value is ignored, not rejected: the request answers as if the key were absent. That is the rule
  for every key outside the settable set (`@mutability: writeOnce` on PATCH, the TPH discriminator,
  `@autoSet: onCreate`), and it is load-bearing here too: a generated edit form submits every
  field it was given, so a `400` on a present key would fail every save.
- **A present `null` is a write**, so it does not reach a denied column either.
- **A credential is never returned**: not by list, not by get, not in the echo of a create or
  an update. The key is absent from the object, not `null`.
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
    └── write-ignores-excluded.yaml   # POST / PATCH / PUT / present-null leave tokenHash alone
```

Generated lane only: what is under test is whether each port's GENERATOR emits routes that
honour the marks, which a hand-rolled reference server would satisfy by construction.
