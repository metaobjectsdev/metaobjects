# provider-composition conformance

Five registry/provider error codes are Tier-1 cross-port invariants that the
existing `fixtures/conformance/error-*` corpus **cannot** reach: that corpus is
metadata-input → error, but these codes are triggered by *how providers are
composed and sealed*, not by any metadata document. This small corpus gates them
cross-port.

| Code | Trigger |
|------|---------|
| `ERR_PROVIDER_DUPLICATE_ID` | Two providers in a composition report the same `id`. |
| `ERR_PROVIDER_MISSING_DEPENDENCY` | A provider declares a dependency id absent from the set. |
| `ERR_PROVIDER_DEPENDENCY_CYCLE` | Providers form a dependency cycle (topo-sort cannot proceed). |
| `ERR_PROVIDER_ATTR_CONFLICT` | A provider `extend`s a type, redefining an attr another provider already declared. |
| `ERR_REGISTRY_SEALED` | A registration is attempted against a registry sealed after bootstrap (ADR-0023). |

## Corpus shape

One JSON manifest per scenario (`<code>.json`). Each manifest is:

```jsonc
{
  "description": "human-readable — what the scenario exercises",
  "providers": ["<named-provider-id>", ...],   // composed in listed order
  "expectedError": "ERR_PROVIDER_DUPLICATE_ID", // the code the port must surface
  "sealThenRegister": "<named-provider-id>"      // OPTIONAL — see "registry-sealed"
}
```

Each port's runner:

1. Reads a manifest.
2. Maps each name in `providers` to that port's **canonical named provider** (see below).
3. Composes a registry from them (the port's `composeRegistry` equivalent).
4. For the ordinary scenarios: the compose call itself throws — assert the caught
   error's stable `.code` equals `expectedError`.
5. For the `registry-sealed` scenario (manifest carries `sealThenRegister`): compose
   succeeds, then the runner `seal()`s the resulting registry and runs the named
   `sealThenRegister` provider's `registerTypes` against the **sealed** registry —
   that mutation must throw `expectedError`.

Every port MUST supply the same canonical named-provider set (below) so a manifest's
`providers` list resolves identically everywhere. The named providers are **test-only**
— they live in each port's conformance test code, never in shipped metamodel providers.

## Canonical named-provider set

Each entry: `id`, `dependencies`, and what `registerTypes` does. Ports implement
them idiomatically but with **identical id / dependencies / registration behavior**.

### `duplicate-x`
- **id:** `"duplicate-x"`
- **dependencies:** none
- **registerTypes:** no-op.

### `duplicate-x-clone`
- **id:** `"duplicate-x"` — *deliberately the same id as `duplicate-x`* (the map key
  used to look it up is `duplicate-x-clone`, but the provider's reported `.id` is
  `duplicate-x`, so the collision surfaces at compose time).
- **dependencies:** none
- **registerTypes:** no-op.

Composing `["duplicate-x", "duplicate-x-clone"]` → `ERR_PROVIDER_DUPLICATE_ID`.

### `depends-on-missing`
- **id:** `"depends-on-missing"`
- **dependencies:** `["does-not-exist"]` — an id no provider in the set supplies.
- **registerTypes:** no-op.

Composing `["depends-on-missing"]` → `ERR_PROVIDER_MISSING_DEPENDENCY`.

### `cycle-a`
- **id:** `"cycle-a"`
- **dependencies:** `["cycle-b"]`
- **registerTypes:** no-op.

### `cycle-b`
- **id:** `"cycle-b"`
- **dependencies:** `["cycle-a"]`
- **registerTypes:** no-op.

Composing `["cycle-a", "cycle-b"]` → `ERR_PROVIDER_DEPENDENCY_CYCLE`.

### `attr-conflict-base`
- **id:** `"attr-conflict-base"`
- **dependencies:** none
- **registerTypes:** registers ONE test-only type/subtype (a fresh, otherwise-unused
  pair) carrying a single string attr named `conflictAttr`. The type/subtype pair is
  chosen so it does not collide with any real core type; it exists only to be extended
  by `attr-conflict-clash`. A wildcard attr child-rule is fine. Concretely the TS
  reference registers `template.compositionprobe` with attr `conflictAttr` (string);
  other ports pick an equivalent fresh pair on a type their provider model already
  supports registering.

Composing `["attr-conflict-base"]` alone must **succeed** (it is also the base for the
`registry-sealed` scenario).

### `attr-conflict-clash`
- **id:** `"attr-conflict-clash"`
- **dependencies:** `["attr-conflict-base"]`
- **registerTypes:** `extend`s the same test-only type/subtype that `attr-conflict-base`
  registered, adding an attr **with the same name** (`conflictAttr`). The registry's
  additive-extend path rejects redefining an already-declared attr.

Composing `["attr-conflict-base", "attr-conflict-clash"]` → `ERR_PROVIDER_ATTR_CONFLICT`.

### `seal-probe`
- **id:** `"seal-probe"`
- **dependencies:** none
- **registerTypes:** attempts ONE mutating registration (e.g. register a fresh
  test-only type, or `extend` an existing one, or `registerCommonAttrs`). Against a
  sealed registry this must throw `ERR_REGISTRY_SEALED`. This provider is **only**
  used via a manifest's `sealThenRegister` — never composed directly.

## Notes

- `ERR_REGISTRY_SEALED` is a **five-port** invariant here. It was previously exercised
  in per-port unit tests only for TS / Python / C#; this corpus adds it to Java and
  Kotlin (which shares the JVM metadata registry).
- `attr-conflict` and `registry-sealed` are the two scenarios whose named providers
  actually register/extend types. All the others use no-op providers, so their id /
  dependencies wiring is the entire contract.
- The `.code` read off a caught exception is the assertion surface — message text is
  never compared (message wording is per-port).

## The `compose-load/` subdir (#265)

#265 gates a **different** invariant than the five error codes above: strict attr
scoping must not wrongly prune an attribute a *consumer* provider added (via
`registry.extend()`) to a spec-declared **core** subtype. That requires composing a
consumer provider on top of the port's real **library** provider set (not just named
test providers in isolation) and, for two of the four scenarios, strict-loading an
actual metadata document against the composed registry — a shape the five
error-code manifests above don't need and don't carry.

These `compose-load/` fixtures live in their **own subdirectory**, not the flat
corpus dir, for backward compatibility: every existing runner (TS / Python / C# /
Java) lists the corpus directory **non-recursively** and hard-requires the old
`{description, providers[], expectedError, sealThenRegister?}` shape for every
`.json` file it finds there. Dropping a new-shape manifest into the flat dir would
red every not-yet-updated runner. `compose-load/` is invisible to a non-recursive
`readdir` of the parent, so an un-updated runner keeps passing unchanged; a runner
that has been extended for #265 globs `compose-load/` as a **second**, separate
pass. The flat dir's 5 existing manifests are unchanged.

### Shape

Each `compose-load/*.json` manifest carries some or all of these OPTIONAL keys
(`description` and `providers` are still present; `expectedError` /
`sealThenRegister` from the flat-dir shape do NOT appear here — a runner dispatches
on which shape a manifest carries):

```jsonc
{
  "description": "...",
  "providers": ["extend-spec-subtype"],     // named test providers, composed AFTER the library core set
  "composeWithCore": true,                   // compose the port's LIBRARY provider set first, then `providers`
  "expectAttrs": {                           // OPTIONAL registry-inspection: the port's declared-attr lookup its strict check uses
    "type": "view", "subType": "currency", "contains": ["locale", "decimals"]
  },
  "metadata": { "metadata.root": { "..." : "..." } }, // OPTIONAL canonical-JSON doc to strict-load
  "expectErrors": ["ERR_UNKNOWN_ATTR"]       // OPTIONAL error codes the strict load must surface ([] = expect success)
}
```

Runner behavior:

1. If `composeWithCore`, compose `[...libraryProviders, ...namedProviders]`; else
   (today's flat-dir behavior) compose the named providers alone.
2. If `expectAttrs` is present, assert the port's declared-attr set for
   `(type, subType)` is a **superset** of `contains` (flat lookup in TS / Python /
   C#; Java via `typeDef.getChildRequirement(name)`, direct-or-inherited).
3. If `metadata` is present, strict-load it and assert the surfaced `.code`s equal
   `expectErrors` exactly (order-insensitive; `[]` means the load must surface zero
   errors).

No new error codes: these scenarios only ever surface `ERR_UNKNOWN_ATTR` (already
gated above) or nothing.

### Canonical named provider `extend-spec-subtype`

- **id:** `"extend-spec-subtype"`
- **dependencies:** **none** — deliberately. The provider that registers
  `view.currency` (the library's core-types provider) has a **different id per
  port**, and this corpus mandates an identical id/dependency set across ports for
  every named provider — so `extend-spec-subtype` cannot name that provider as a
  dependency without breaking cross-port id parity. Ordering is instead guaranteed
  by the `composeWithCore` contract: the library set composes first, the named set
  is appended after, and every port's compose is a **stable** topological sort that
  preserves input order among providers with no ordering constraint between them.
  `composeWithCore` is the sanctioned exception to Python's "an extender MUST
  declare a dependency on what it extends" docstring guidance — it's a corpus-level
  ordering guarantee, not a per-provider one.
- **registerTypes:** `extend`s `view.currency` (a subtype the library's own core
  provider registers) with one new **int** attr, `decimals`.

Composing `[...coreProviders, "extend-spec-subtype"]` must succeed, and the
resulting registry's declared-attr set for `(view, currency)` contains BOTH
`locale` (core-declared) and `decimals` (consumer-added).

### The four fixtures

1. **`extend-spec-subtype-registry`** — `composeWithCore` + `extend-spec-subtype`;
   asserts `(view, currency)` in the composed registry's declared-attr lookup
   contains `locale` and `decimals`.
2. **`extend-spec-subtype-strict-load`** — same composition, plus a metadata
   document with a `field.currency` (the structural parent a `view.currency` child
   is admitted under; `@currency` itself may be omitted, it defaults to `USD`)
   carrying a `view.currency @decimals: 2` child. Strict-loads with
   `expectErrors: []` — the consumer-added attr is accepted, not pruned.
3. **`extend-spec-subtype-typo-rejected`** — same shape, but `@decimalz: 2` (a
   typo — not the provider-registered name). Strict-loads with
   `expectErrors: ["ERR_UNKNOWN_ATTR"]` — the extension widens scoping for its own
   declared attr only, never for an arbitrary name.
4. **`misplaced-core-attr-consumer-registry`** — same composition (a consumer
   provider IS composed in), but the metadata document puts `@maxLength` (a CORE
   attr declared only on `field.string`) on a `field.boolean`. Strict-loads with
   `expectErrors: ["ERR_UNKNOWN_ATTR"]` — proves the provenance guard doesn't
   accidentally widen scoping for misplaced CORE attrs just because a consumer
   provider is present in the composition.
