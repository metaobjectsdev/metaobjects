# Migration — `@violation` becomes `@counterexample` (`0.25.0` / Maven `7.25.0`)

**Breaking, and fully automatic.** Run:

```
meta upgrade --apply
```

That is the whole migration. `@violation` is a pure rename with no semantic change, so the
tool rewrites every occurrence and there is nothing to decide.

Under the strict, sealed registry (ADR-0023) there is no deprecation shim — metadata still
carrying `@violation` fails the **load**, in every language port, with a message naming the
rename and pointing here.

## Why rename it

The field has always held a **static falsifiability test**: *what would contradict this
requirement*, authored once, never changing. It is what makes a requirement checkable at all
— *"every entity has a uuid primary key"* is violable (point at one with a composite string
key), while *"things are persisted"* is not, and is a description rather than a requirement.

**`@violation` read as a status.** Every reader who met the name asked the same question:
does this mean the requirement is *currently in violation*? It does not, and never did — but
a field named for a state, sitting beside `@status`, invites exactly that reading. The name
misled the person who approved the vocabulary, which is the clearest possible evidence that
it was wrong.

`@counterexample` says what the field holds. It is a noun, parallel to `@statement`, and
nobody reads it as a state.

## What is NOT changing

- **The semantics.** Same field, same requirement that it be present, same role in making a
  requirement falsifiable.
- **Where it is legal.** Both `requirement.functional` and `requirement.architectural`, still
  required on both.
- **Anything else in the requirement vocabulary.** `@statement`, `@status`, `@level`,
  `@implementedBy`, `@disposition`, `@trackedBy` are untouched.

## Doing it by hand

If you would rather not run the tool, the change is mechanical:

```jsonc
{ "requirement.functional": {
    "name": "OrderRecord", "@level": 4, "@status": "live",
    "@statement": "An order records what was bought and for how much",
-   "@violation": "An order row that cannot say who placed it",
+   "@counterexample": "An order row that cannot say who placed it",
    "@implementedBy": ["acme::shop::Order"]
}}
```

In YAML, authoring is sigil-free, so it is the bare key:

```yaml
requirement.functional:
  name: OrderRecord
-  violation: An order row that cannot say who placed it
+  counterexample: An order row that cannot say who placed it
```

## If you consume it in code

The per-port constant is renamed alongside the attribute:

| port | before | after |
|---|---|---|
| TypeScript | `REQUIREMENT_ATTR_VIOLATION` | `REQUIREMENT_ATTR_COUNTEREXAMPLE` |
| C# | `REQUIREMENT_ATTR_VIOLATION` | `REQUIREMENT_ATTR_COUNTEREXAMPLE` |
| Python | `REQUIREMENT_ATTR_VIOLATION` | `REQUIREMENT_ATTR_COUNTEREXAMPLE` |
| Java | `MetaRequirement.ATTR_VIOLATION` | `MetaRequirement.ATTR_COUNTEREXAMPLE` |

Java's accessor `getViolation()` becomes `getCounterexample()`.

`meta upgrade` rewrites **metadata**, not source code — it operates on your metadata
documents and never touches your application. Renaming a constant reference in your own code
is a compiler-guided edit.
