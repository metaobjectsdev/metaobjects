# generator-registry conformance

The canonical cross-port manifest of **stable generator names** (ADR-0021 D3).
`registry.json` is the single source of truth; every port's generator registry is
conformance-tested against it.

## The contract each port's test enforces

Given the port's own generator registry (stable-name → generator), the port's
conformance test asserts:

1. **No rogue names** — every stable name the port registers appears in
   `registry.json`.
2. **Presence both ways** — for every manifest entry whose `ports` array includes
   this port, the port's registry exposes that name; and the port does **not**
   expose a name whose `ports` array omits it.
3. **Tier agreement** — a name marked `tier: "neutral"` is flagged neutral in the
   port (owned by `meta docs`, not the recommended native suite).

Because all five ports validate against this one file, a **shared concept is
spelled identically everywhere** (e.g. the REST surface is `routes` in every
port, never `controller`/`router`). That cross-port spelling stability is the
whole point.

## Shared (cross-port) names

These concepts MUST use the same stable name wherever a port implements them:
`entity`, `routes`, `output-parser`, `output-prompt`, `render-helper`,
`extractor`, `template`, `filter-allowlist`, `payload`.

## Changing the surface

Adding, removing, or renaming a generator means editing **both** `registry.json`
**and** the port's registry in the same change — the conformance gate fails on
any drift (a typo'd name, a missing registration, a port that quietly diverges).
This is the mechanism that keeps the codegen surface coherent as it grows.

## Port ids

`typescript`, `csharp`, `java`, `kotlin`, `python`.
