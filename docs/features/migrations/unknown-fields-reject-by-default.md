# Undeclared request keys are refused by default (`api.unknownFields`)

From 1.3.0, a generated create, PUT or PATCH route refuses a body that carries a key the entity
does not declare:

```http
POST /api/customers
{ "name": "Ada", "emial": "ada@example.com" }

400 { "error": "unknown_fields", "fields": ["emial"] }
```

Before 1.3.0 every port dropped such a key silently and answered 201, so a misspelled field lost
its value without a word. The new default applies to **existing projects too**, the first time
they regenerate their routes on 1.3.0, in every port (TypeScript, C#, Java, Kotlin, Python).

## What counts as undeclared

A top-level key no field of the entity is named (on a single-table hierarchy's routes, no field
of the base or any subtype). These are all **declared**, so they are still dropped silently,
never refused:

- the generated primary key (`id`), an `@autoSet` stamp, a `readOnly` or derived field;
- a `writeOnce` field on PATCH or PUT;
- the TPH discriminator, and a column only a sibling subtype declares.

So a client that reads a row and sends it back, edited, keeps working. Value-object members are
validated as before; only the top level is checked.

## Do you need to do anything?

Probably not, if your clients are the generated hooks and forms: they send only declared fields.
Check before you deploy if a client of yours:

- sends extra keys on purpose (a UI-only flag, a nested relation, a field from another entity);
- posts a payload built for another API or an older version of the model, where a field has since
  been renamed or removed.

Search your server logs or tests for 400 answers with `"error": "unknown_fields"` after the upgrade;
the `fields` list names every key to fix.

## To keep the old behaviour

Set `drop` in `.metaobjects/config.json` and regenerate:

```json
{ "api": { "unknownFields": "drop" } }
```

Every port reads this one key. Undeclared keys are then ignored and the rest of the body is
written, exactly as before 1.3.0.

## Owned (ejected) routes

An ejected routes generator keeps what it emitted when you copied it, so it keeps dropping until
you re-eject it with your port's eject command (`meta eject`, `dotnet meta eject`,
`mvn metaobjects:eject`, `metaobjects eject`) or make the change in your copy. In TypeScript the generated mount passes the
entity's declared fields as `knownFields`; a mount given none drops undeclared keys.

See [api-contract.md](../api-contract.md#unknown-request-fields-apiunknownfields) for the contract.
