# Migrating to the template DIRECTION split (ADR-0052 / ADR-0053)

A template subtype's axis is now **direction**, not topic. `template.output` renders
OUTBOUND and generates nothing that reads a model's reply; the inbound half — the
response shape, the FR-010 response-format fragment, the parser-on-receipt and the
tolerant extractor — belongs to a `template.prompt` carrying `@responseRef`.

Two things change for an existing model:

1. **A `@promptStyle` on a `template.output` now fails the load.** It is prompt-only
   vocabulary. Same for `@responseFormat`, which is new.
2. **A `template.output` no longer generates a parser, an extractor or a
   response-format fragment.** Those files disappear on the next `gen`, and
   `verify --codegen` reports the committed ones as files a fresh regen would not emit.

Nothing changes silently: (1) is a load error, and (2) is a diff.

---

## Why

The old tier keyed on the wrong thing, and had drifted three ways at once:

* the **parser** applied NO format filter, so an `@format: markdown` document template
  got a generated `Schema.parse(JSON.parse(text))` over rendered prose — a function that
  could never work, and one this repository shipped in `examples/advanced-modeling`;
* the **response-format fragment** and the **extractor** each applied their own
  `@format ∈ {json, xml}` gate — against the OUTBOUND body's syntax, which says nothing
  about the reply. A text-bodied prompt asking for a JSON answer, the common case, got a
  strict parser and no tolerant extract;
* nothing generated the inbound tier for a `template.prompt` at all, even though
  `@responseRef` — the attribute that names the reply shape — has been prompt-only
  vocabulary since it was introduced.

The rule that replaces all of it is one predicate in one place per port (`FindInbound`):
**a template is inbound iff it is a `template.prompt` declaring `@responseRef`.** The gate
is PRESENCE, never a format value.

ADR-0053 supplies the missing fact: `@responseFormat` (`json` | `xml`, default `json`) is
the syntax of the REPLY, distinct from `@format`, the syntax of the rendered prompt BODY.

---

## 1. `@promptStyle` on a `template.output`

### The error you'll see

```
ERR_INVALID_TEMPLATE: template.output "OrderSummary" carries @promptStyle,
which is only valid on template.prompt
```

### The fix

Ask what the node is for.

**It was really a prompt.** The `@promptStyle` was there to shape a
"produce your answer like this" fragment, which means something reads the answer. Convert
it, and say what the reply is:

```diff
-- template.output:
+- template.prompt:
     name: OrderSummary
     "@payloadRef": OrderSummaryPayload
     "@textRef": shop/order-summary
--    "@format": json
+    "@format": text            # the syntax of the prompt BODY
+    "@responseRef": OrderSummaryResponse
+    "@responseFormat": json    # the syntax of the REPLY
     "@promptStyle": inline
```

Note `@payloadRef` and `@responseRef` are usually **different** shapes: the first types
the request you render, the second the answer you parse. If your old model used one
value-object for both, that is a signal worth acting on — the question and the answer
rarely have the same fields.

**It was really a document.** Drop the attribute; nothing else changes.

```diff
 - template.output:
     name: InvoicePdf
     "@payloadRef": InvoicePayload
     "@textRef": billing/invoice
     "@format": html
--    "@promptStyle": guide
```

---

## 2. The inbound artifacts move

For a `template.output`, these files are no longer emitted. Delete the committed copies
(`verify --codegen` names them for you) and re-run `gen`:

| Port | No longer emitted for `template.output` |
|---|---|
| TypeScript | `<Name>.output.ts`, `<Name>.prompt.ts`, `<Name>.extractor.ts` |
| C# | `<Name>.output.cs`, `<Name>.prompt.cs` |
| Java | `<Name>Parser.java`, `<Name>Prompt.java` |
| Kotlin | `<Name>Parser.kt`, `<Name>Prompt.kt`, `<Name>Extractor.kt` |
| Python | `<name>_output_parser.py`, `<name>_output_prompt.py`, `<name>_extractor.py` |

For a **responding `template.prompt`** they appear under direction-named paths:

| Port | Parser | Response-format fragment | Extractor |
|---|---|---|---|
| TypeScript | `<Prompt>.response.ts` | `<Prompt>.responseFormat.ts` | `<Prompt>.extractor.ts` |
| C# | `<Prompt>.response.cs` | `<Prompt>.responseFormat.cs` | `<Prompt>.extractor.cs` |
| Java | `<Prompt>Parser.java` | `<Prompt>ResponseFormat.java` | — |
| Kotlin | `<Prompt>Parser.kt` | `<Prompt>ResponseFormat.kt` | `<Prompt>Extractor.kt` |
| Python | `<prompt>_response_parser.py` | `<prompt>_response_format.py` | `<prompt>_extractor.py` |

The render helper is unchanged and stays with `template.output`.

### The response RECORD

`@responseRef` names a shape, and that shape needs a strict record for the parser to
return. Where it comes from differs by port, because the ports do not share a naming
convention — and this is the one place the migration is not purely mechanical:

* **TypeScript** — no new record. Payload types come from `entityFile()`, which emits per
  `object.value` regardless of any template.
* **C#** — no new convention. Records are named after the resolved VALUE OBJECT, so the
  response record simply IS that VO's record.
* **Java / Kotlin** — records are TEMPLATE-named, so a responding prompt gets a SECOND
  one: `<Prompt>Response` beside `<Prompt>Payload`.
* **Python** — same second record, in its own module `<prompt>_response.py`. Separate
  because strictness is per-module: the REQUEST payload emits `extra="forbid"` so a
  mistyped render slot fails at construction, while a reply record must tolerate unknown
  fields, and a value-object reachable from both closures could only carry one setting.

---

## 3. `@responseFormat`, and the strict tier

`@responseFormat` defaults to `json`, which reproduces the pre-ADR fallback exactly
(anything that was not `"xml"` was treated as JSON). So an existing model that never
declared it keeps its behaviour.

Declare `@responseFormat: xml` when the reply is XML — and note that **the strict tier is
JSON-only**. An XML reply gets the tolerant extract and no `parse`/`Parse`/`parse_*`. That
is not a gap: the XML reader is forgiving by design, and strict all-or-nothing semantics
layered over a REPAIRING parser would raise or accept based on how much repair happened,
which is not a contract anyone can reason about.

If you were previously modelling an XML reply as a second `template.output` with
`@format: xml` — the old workaround for getting an XML response-format fragment — that
node is now redundant. Move the fact onto the prompt:

```diff
 - template.prompt:
     name: npcReview
     "@payloadRef": NpcPayload
     "@responseRef": NpcResponse
     "@textRef": ai/npc-review
     "@format": text
+    "@responseFormat": xml

-- template.output:
--    name: npcReviewOutput
--    "@payloadRef": NpcResponse
--    "@textRef": ai/npc-response-format
--    "@format": xml
```

---

## 4. `@responseRef` now obeys the payload-target rule everywhere

`@responseRef` must resolve to an `object.value` or a sourceless `object.projection` —
the same rule `@payloadRef` has always obeyed. **Only TypeScript enforced this.** C#,
Java and Python checked `@payloadRef` and never `@responseRef`, so the same metadata
failed one port's load and passed four; in C# the consequence was generated code that did
not compile (a parser returning a record nobody emitted, CS0246).

```
ERR_INVALID_TEMPLATE: template "AskPrompt" @responseRef "Answer" does not resolve
to an object.value or sourceless object.projection at root
```

If you hit this on a port that used to accept it, the metadata was always wrong — point
`@responseRef` at a value-object (or a sourceless projection), not an entity.

---

## Checklist

- [ ] `gen` and read the diff — deleted inbound files under `template.output` names are expected.
- [ ] `verify --codegen` names any committed file a fresh regen would not emit; delete those.
- [ ] Every `template.output` that had `@promptStyle`: decide prompt or document, per §1.
- [ ] Every prompt whose reply you parse: add `@responseRef` (and `@responseFormat` if XML).
- [ ] Re-point consumer imports at the new file/class names.
- [ ] Check that `@payloadRef` and `@responseRef` really are the shapes you meant — the request and the reply.

## See also

- [ADR-0052 — a template subtype's axis is direction](../../../spec/decisions/ADR-0052-template-direction-outbound-vs-inbound.md)
- [ADR-0053 — the reply's syntax is `@responseFormat`](../../../spec/decisions/ADR-0053-inbound-response-format.md)
- [`docs/features/templates-and-payloads.md`](../templates-and-payloads.md)
