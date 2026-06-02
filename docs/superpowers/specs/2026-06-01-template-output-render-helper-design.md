# `template.output` Render-Helper Codegen — Design

_Date: 2026-06-01. Status: approved (design). Scope: TS + Java first; C#/Python/Kotlin phase 2. Builds on the shipped FR-004 render pillar (`render()`) + `verify()` drift check._

## Problem

`template.output` can already carry a payload VO (`@payloadRef`), a Mustache text reference (`@textRef`), an output `@format` (`text|html|xml|csv|json|markdown|spreadsheet`), `@maxChars`, and `@requiredTags`. The shared cross-port **`render()`** engine resolves the template text via a provider, runs the **`verify()`** drift check (every `{{field}}` must exist on the payload VO), escapes per format, renders Mustache, and budget-guards. But there is **no codegen helper** that wires a specific `template.output` to its render call — so adopters hand-write `render({ ref, payload, format, provider, verify: <hand-built field tree> })` for every email/HTML/document output. That boilerplate is the gap (and why email rendering gets hacked around). The drift check also only runs at render time today.

(The user's recollected `template.document` metatype never existed; `template.output` is the metatype, and these are codegen + small metamodel additions on it — no new subtype.)

## Goal

Generate, per `template.output`, a typed **render helper** that takes the payload VO and produces the output — a single string for `document` kinds, an `EmailDocument` for the `email` kind — reusing the existing `render()` + `verify()` engines, with the **mustache↔VO drift check enforced at BUILD time** (the `.mustache` files are in the repo at codegen time).

## Metamodel additions (shared loader, all ports)

On `template.output`:
- **`@kind`** (string, optional, default `"document"`) — closed enum `document | email`.
- **`document` kind** (default): renders the existing `@textRef` in `@format` → a single string. No other new attrs (uses `@textRef`, `@format`, `@maxChars`, `@requiredTags` as today).
- **`email` kind**: declares its MIME `multipart/alternative` parts as Mustache refs over the **same** payload VO:
  - **`@subjectRef`** (required when `kind=email`) — rendered as text (the subject line).
  - **`@htmlBodyRef`** (required when `kind=email`) — rendered `@format=html` (the rich body).
  - **`@textBodyRef`** (optional) — rendered as text (the plain-text alternative).
- **Load-time validation:** `kind=email` requires `@subjectRef` + `@htmlBodyRef` (and ignores/forbids `@textRef`); `kind=document` (or absent) requires `@textRef`. `@kind` is closed-enum validated. Mirrors the existing `template.output` schema validation.

## Codegen: the render helper (per `template.output`, per port)

Reuses the closest existing pattern — the per-`template.output` prompt-fragment generator (TS `output-prompt.ts` emitting `render<Name>Format`) — but emits a render helper instead.

- **`document` kind →** `render<Name>(payload, provider): string`:
  ```
  render<Name>(payload, provider) =
    render({ ref: "<@textRef>", payload, format: <@format>, provider,
             verify: <baked payload field-tree>, maxChars: <@maxChars?> })
  ```
  Bakes the template's `@textRef`, `@format`, `@maxChars`, and the payload VO's field-tree (so the runtime drift check runs). The adopter calls `renderWelcomePage(payload, provider)`.
- **`email` kind →** `render<Name>(payload, provider): EmailDocument`:
  - renders `@subjectRef` (text), `@htmlBodyRef` (html), `@textBodyRef` (text, if present), each via `render()` over the same payload, and assembles `EmailDocument { subject, htmlBody, textBody? }`.
- **`EmailDocument`** is a small per-port type: TS `interface { subject: string; htmlBody: string; textBody?: string }`, Java `record EmailDocument(String subject, String htmlBody, String textBody)` (textBody nullable), etc. Lives in the render library (shared) or the generated module — decided per port in the plan, preferring the render library so it's one shared shape.
- **`payload`** is the template's typed payload VO (the existing payload-VO codegen output) where available, else a plain object/map. The helper's input is the typed payload, so VO validation is by-type.
- **`provider`** resolves `@textRef`/part-refs + partials at runtime (consistent with the engine — template text stays external/in-repo, not embedded), so a template can change without regenerating the helper.

## Validation (the existing machinery, at a new time)

1. **Build-time mustache↔VO drift gate (new timing):** at codegen, the generator resolves each referenced `.mustache` (document: `@textRef`; email: `@subjectRef`/`@htmlBodyRef`/`@textBodyRef`) from the build-time template root and runs the existing `verify(text, payloadFieldTree)`. Any `ERR_VAR_NOT_ON_PAYLOAD` / unresolved `{{> partial}}` / missing `@requiredTags` tag **fails the build/codegen** with a precise, file-attributed error. This is the "entries in the mustache file match the VO" check, now at build time, per part. Requires a build-time provider/root pointing at the in-repo templates (the generator config supplies it).
2. **VO payload validation:** unchanged — the loader validates the payload VO; the helper takes the typed payload.
3. **Runtime drift (unchanged):** the generated helper passes the field-tree to `render()`'s `verify`, so a stale runtime template still throws. Build-time + runtime = belt and suspenders, both from the same `verify()`.

No new validation logic — `verify()` is invoked at build time in addition to render time.

## Testing

- **Compile-and-run proof per port (TS + Java):** generate the helper for a `document` `template.output` (html) and an `email` `template.output`; compile; run `render<Name>(payload, provider)` against an in-memory template + payload; assert the rendered string / `EmailDocument` parts are correct.
- **Build-time drift gate proof:** a fixture whose mustache references a field NOT on the payload VO → assert codegen FAILS with `ERR_VAR_NOT_ON_PAYLOAD` naming the field + template. (And the inverse: a clean template → codegen succeeds.)
- **Shared conformance fixture:** `fixtures/template-output-render-conformance/` (or extend the existing template-output corpus) with a `document` case + an `email` case + a drift case, pinning behavior for the phase-2 ports to match.
- **Engine unchanged:** `render()`/`verify()` are reused as-is; existing render-conformance + verify tests stay green.

## Scope & sequencing

- **Phase 1 (this effort): TS + Java.** Full vertical: the `@kind`/part metamodel (in the shared loader — landed once, all ports parse it), the render-helper generator + build-time drift gate + the `email` shape + the `EmailDocument` type, compile-and-run + drift-gate tests, and the shared conformance fixture, in TS and Java.
- **Phase 2 (documented follow-up): C#, Python, Kotlin.** Codegen helper + `EmailDocument` + the build-time gate, matching the shared fixture. The `render()`/`verify()` engines already exist in all 5, so phase 2 is codegen-only.
- Single branch `worktree-template-output-render`, one merge for phase 1.

## Out of scope

- New render/verify engine behavior (reused as-is).
- Multi-part documents beyond email (`subject/html/text`) — the part model can extend later.
- Actually SENDING email (SMTP/providers) — this produces the `EmailDocument`; delivery is the adopter's.
- Embedding template text into generated code (templates stay provider-resolved/in-repo).
- Publish — deferred to explicit user confirm.
