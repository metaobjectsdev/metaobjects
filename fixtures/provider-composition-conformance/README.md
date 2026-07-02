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
