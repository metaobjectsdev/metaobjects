# Reject subtype-specific template attrs on the wrong template subtype

_Status: DELIVERED (Python port). Date: 2026-06-13._

## Problem

The metamodel registers template attrs **per subtype**: prompt-only attrs
(`@maxTokens` / `@requiredSlots` / `@model` / `@responseRef`) on `template.prompt`,
output-only attrs (`@promptStyle` / `@kind` / `@subjectRef` / `@htmlBodyRef` /
`@textBodyRef`) on `template.output`, and `@toolName` on `template.toolcall`. But the
loader is **lenient about misplaced attrs** — declaring a prompt-only attr on a
`template.output` (or vice versa) loads with **zero errors**, the attr silently
ignored:

```json
{ "template.output": { "name": "O", "@payloadRef": "P", "@textRef": "g/o",
                       "@format": "json", "@maxTokens": 500 } }   // loads clean today
```

This hides authoring mistakes — e.g. someone reaching for a prompt knob on an output
template gets no signal that it does nothing.

## Decision

`_validate_templates` (the existing template validation pass that already owns the
`@kind`/email cross-field rules) now emits **`ERR_INVALID_TEMPLATE`** when a
subtype-specific attr appears on a template whose subtype is not the one it is
registered for. The existing `ERR_INVALID_TEMPLATE` code is reused (no new error code
→ no cross-port code-registration churn), with a precise message:

```
template.output "O" carries @maxTokens, which is only valid on template.prompt
```

The check reads the node's **own** attrs (`tpl.attr(...)`, not the `@extends`
super-chain), matching every other rule in the pass. A `_TEMPLATE_SUBTYPE_ONLY_ATTRS`
map encodes the prompt/output/toolcall-only attrs — mirroring the per-subtype
`TEMPLATE_ATTRS_MAP` split the other ports already carry.

## Scope

- **In:** the subtype-specific prompt/output/toolcall attrs landing on the wrong
  subtype — the exact "output vs prompt attribute" mistake.
- **Out (deliberately):** a general "reject *any* unregistered attr on a template"
  strict gate. That is a broader back-compat + cross-port decision (it would also
  reject typos like `@totallyFake`), and is left as a possible follow-up.

## Tests

`tests/unit/test_template_wrong_subtype_attrs.py` — `@maxTokens` on output,
`@promptStyle` on prompt, and `@toolName` on prompt are each rejected; the same attrs
on their own subtype load clean. Full non-integration suite green.

## Cross-port follow-up

This ships in the **Python** port (the one driving the need). TS / Java / C# / Kotlin
should add the equivalent check, after which a shared `fixtures/conformance/error-*`
fixture can pin it cross-port. The fixture is intentionally **not** added here — a
shared error fixture would red-list the other ports' conformance runners until they
implement the rule.
