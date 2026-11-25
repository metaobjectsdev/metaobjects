---
name: metaobjects-prompts
description: Use when writing, editing or reviewing code that builds text sent to an LLM (string formatting, f-strings, text blocks, template literals, string builders, concatenation) or reads an LLM reply (regex, string search, JSON or XML parsing), in a project that declares template.prompt nodes; test harnesses and scripts count. That code belongs in a template, a payload VO and a response model. Also for declaring template.prompt/template.output, typed payload projections, provider-resolved text, deterministic render, prompt-drift verify and parser-on-receipt, including a MetaObjects project that has no template.prompt yet and wants to move existing LLM code onto them. Do not use to edit existing LLM code in a project that declares no template.prompt when the task is not declaring prompts.
---

# MetaObjects prompt construction

**A prompt is code, not a string scattered across services.** Declare its payload as a typed
shape (payload bloat becomes a diff), keep its text external and provider-resolved, and render
it deterministically: snapshot-testable, cache-stable and drift-checked at build time. The
same machinery renders any text artifact: emails, exports, docs, `llms.txt`.

## Essentials

- **Read your server language's reference file before writing or reviewing prompt code.** It
  has the render and parse API, the generated parser names and the format fragment for that
  language; this file has the rules every port shares.
- **Once a project declares any `template.prompt`, every LLM prompt should be one.** Asked to
  change a hand-built prompt, migrate it first and then make the change: a line added to the
  hand-built string is how a migrated codebase slides back.
- **Prompt text never lives in metadata or in code.** `@textRef` names it and a provider
  resolves it; values come from the payload, never from string formatting at the call site.
- **Wording that varies is payload data and flags, never prose branched in a service.**
- **`@responseRef` on a `template.prompt` is what generates the reply side** (response type,
  format fragment, parsers). For a raw chat reply use the tolerant extract; the strict parse
  is for a guaranteed bare-JSON body. A `template.output` never has a reply side.
- **`@format` is the syntax of the body you render; `@responseFormat` is the syntax of the
  answer you expect.** A plain-text prompt asking for JSON is the common case.
- **Run the template drift check in CI.** It fails the build when the text references a
  field the payload does not have.

## Reference files — open the one for your server language

Only the files for the server languages in this project's stack are installed.

| File | Open it when |
|---|---|
| `references/typescript.md` | the project's server language is TypeScript |
| `references/java.md` | the project's server language is Java |
| `references/kotlin.md` | the project's server language is Kotlin |
| `references/csharp.md` | the project's server language is C# |
| `references/python.md` | the project's server language is Python |

## Touching a hand-built prompt? Migrate it, don't extend it

This skill applies to code that does not look like MetaObjects: a `String.format` or text
block, an f-string, a template literal, a `StringBuilder`, or a string concatenation whose
result is sent to an LLM, and a regex or string search that pulls fields out of the reply.
Look in every module, not only the application: test harnesses, simulators, evaluation
scripts and tooling build prompts too.

The migration is safe because it is checked against the old output:

1. **Snapshot the current output** for one or more representative inputs, as a test fixture.
2. **Declare the payload**: an `object.value` for caller-supplied fields, or a sourceless
   `object.projection` when fields are derived. Only the fields the text uses.
3. **Declare the `template.prompt`** and move the text into its external template file.
4. **If the code reads the reply**, add `@responseRef` to a response model and replace the
   regex or ad-hoc parsing with the generated extractor.
5. **Render and compare with the snapshot.** Keep it byte-identical; review any intended
   difference on its own.
6. **Then make the change the task asked for**, in the template text or the payload.

## The template subtypes

A template is a typed pair: a logical reference to external text, and a payload shape
declaring exactly the data the text expects. The subtype says which way text travels.

| Subtype | Direction | Use | Extra attrs |
|---|---|---|---|
| `template.prompt` | outbound, and optionally inbound | LLM-targeted | `@maxTokens`, `@requiredSlots`, `@requiredTags`, `@model`, `@responseRef`, `@responseFormat`, `@promptStyle` |
| `template.output` | outbound only | email / docs / config / export | `@kind: document \| email` (default `document`), `@requiredTags`; `@kind: email` adds `@subjectRef` / `@htmlBodyRef` / `@textBodyRef` |

Both carry:

| Attr | Required | Purpose |
|---|---|---|
| `@payloadRef` | yes | the `object.value`, or sourceless `object.projection`, declaring the payload shape |
| `@textRef` | yes, except on a `template.output @kind: email`, which carries `@subjectRef` + `@htmlBodyRef` (+ optional `@textBodyRef`) and no `@textRef` | the two-layer logical text reference `group/source`, resolved by a provider |
| `@format` | no | `text` (default) / `html` / `xml` / `csv` / `json` / `markdown` / `spreadsheet`; drives the escaper |
| `@maxChars` | no | build-time size budget |

A `template.output @kind: email` renders a structured `EmailDocument` (subject, HTML body,
optional plain-text body), not one string. `@requiredTags` names tags the rendered text must
contain, checked by `verify`, on both subtypes.

**The reply side belongs to `template.prompt` alone.** `@responseRef` names the shape (an
`object.value` or sourceless `object.projection`) a model's reply is parsed into, and its
presence is what asks for the whole inbound tier. `@responseFormat` (`json` default, or
`xml`) is the syntax of the reply; `@promptStyle` selects how the format fragment presents
the shape. Putting `@responseFormat` or `@promptStyle` on a `template.output` is a load
error: an output renders a document and nothing reads a reply to it.

**`template.toolcall`** (`@toolName` + `@payloadRef`) is a third subtype: a vendor-neutral
LLM tool-call envelope with no text body, so it carries no `@textRef` or `@format`. The
vocabulary exists; MCP exposure of declared prompts and tools has not shipped, so do not
promise it.

## The payload is a shape you declare

The payload is not an entity. It is a declared shape whose fields are the prompt's typed
surface: an `object.value` when the caller supplies the fields, or a sourceless
`object.projection` (no `source.*` child) when fields are derived by assembly. A field's
generated type comes only from its declared `field.<subType>`, `isArray` and `@objectRef`. A
nested payload is a `field.object` with `@objectRef` to another `object.value`
(`isArray: true` for a list). The assembly origins (`origin.aggregate`, `origin.computed`,
`origin.first`) are refused on an `object.value` (`ERR_SUBTYPE_RULE_VIOLATION`); a derived
payload goes on the sourceless projection. Projections in general are covered by the
`metaobjects-authoring` skill.

Declaring the shape is what makes payload bloat visible: adding a field to the prompt is a
diff on the declared shape.

```json
{
  "metadata.root": {
    "package": "acme::blog",
    "children": [
      {
        "object.value": {
          "name": "WelcomePayload",
          "children": [
            { "field.string": { "name": "displayName" } },
            { "field.long": { "name": "postCount" } },
            { "field.object": { "name": "posts", "@objectRef": "PostSummary",
              "isArray": true } }
          ]
        }
      },
      {
        "object.value": {
          "name": "PostSummary",
          "children": [
            { "field.string": { "name": "title" } }
          ]
        }
      },
      {
        "template.prompt": {
          "name": "WelcomePrompt",
          "@payloadRef": "WelcomePayload",
          "@textRef": "lobby/welcome",
          "@format": "xml",
          "@maxTokens": 500
        }
      }
    ]
  }
}
```

## Prompt text is external and provider-resolved

`@textRef` is a two-layer logical reference `group/source` (folder/file, table/key,
collection/document). At runtime a configured provider resolves it to the template text:

- a filesystem provider, the dev default: `lobby/welcome` → `<root>/lobby/welcome.mustache`.
  It is `FilesystemProvider` in every port. In TypeScript it is Node-only and imported from a
  subpath so the package root stays browser-safe:
  `import { FilesystemProvider } from "@metaobjectsdev/render/providers"` (Python
  `metaobjects.render`, C# `MetaObjects.Render`, JVM `com.metaobjects.render`);
- an in-memory provider (a string map) for tests (`InMemoryProvider`, from the package root);
- a classpath or resource provider on the JVM;
- your own (a database, a vector store): implement `Provider`'s one `resolve(ref)` method.

Locale, A/B and dynamic prompt variants all live behind the provider without touching
metadata.

**Jinja bodies (Python and TypeScript only).** A body may be `lobby/welcome.jinja` (or `.j2`
/ `.jinja2`) in place of `welcome.mustache`; the `@textRef` does not change and the metadata
never names an engine. Python renders it with jinja2 (the `metaobjects[jinja]` extra),
TypeScript with nunjucks. The same drift check walks the parsed template and reports what it
cannot settle statically (`user[key]`, a computed include name) as
`ERR_TEMPLATE_NOT_STATIC`. Java, Kotlin and C# refuse a Jinja body with
`ERR_TEMPLATE_ENGINE_UNSUPPORTED`. Prefer Mustache for new templates: it is the engine every
port has, and its logic-less shape is what pushes conditionals into the payload. Jinja is for
adopting existing Jinja templates without rewriting them.

## Render is deterministic and byte-stable

Rendering is a pure function of the payload and the resolved text: the same inputs give
byte-identical output, across runs and across every port. That is what protects exact-prefix
prompt-cache hits and makes a snapshot test meaningful. The engine holds to it this way:

- arrays only for iteration (no object-key iteration);
- no locale, number or date formatting in the engine: pre-format on the payload;
- pinned trailing-newline and Mustache standalone-tag whitespace;
- `@format` drives an engine-owned escaper (the CSV and spreadsheet escapers neutralize a
  leading `= + - @ \t \r`, the CSV-injection guard).

You render the prompt, call your own LLM client (codegen emits nothing provider-specific),
then parse the reply.

## Conditional content: data and flags, never branched prose

When wording varies along some dimension (audience, tier, mode, locale, entitlement), do not
branch the prose in code and concatenate strings. That scatters one distinction across call
sites, each free to drift and none snapshot-tested. The variation belongs in two places, with
a third for real divergence:

- **Vocabulary as payload data.** The words that differ become typed payload fields computed
  once from the dimension: a noun, a label, a list of verbs, an example. The template stays
  single and references `{{term}}` / `{{#items}}…{{/items}}`.
- **Presence as boolean flags.** When a whole block exists or not for a variant, gate it with
  a section the payload sets: `{{#showBlock}}…{{/showBlock}}`. Flags are for whole blocks; a
  mid-sentence word swap is vocabulary.
- **Variant text only when the prose really diverges.** Select a per-variant text through the
  provider (a `@textRef` variant, or an included partial) so the shared prose still lives in
  one place. Expect to need this rarely.

One resolver maps the dimension to the payload (the flags and the vocabulary), so the
distinction is defined once and every template that depends on it stays consistent.

```
// WRONG: prose branched and concatenated in a service
if (tier.isPremium()) sb.append("Your plan includes priority support.");
else                  sb.append("Upgrade any time for priority support.");
```
```mustache
{{! RIGHT: text in the template; the variant is data plus a flag }}
{{supportLine}}
{{#isPremium}}(Priority queue enabled.){{/isPremium}}
```

Render the template against each value of the dimension and snapshot every variant.

## `verify` fails the build on prompt drift

For every `template.prompt` and `template.output`, the verify step resolves the text, parses
each `{{...}}` reference (Mustache, or a Jinja body in Python and TypeScript) and checks it
exists on the payload. If the text references `{{authorName}}` and the payload only has
`displayName`, the build fails. Run it in CI.

## A responding `template.prompt` generates parsers

For every `template.prompt` declaring `@responseRef`, codegen emits a typed parser that turns
a model's reply back into that shape. It binds `@responseRef`, never `@payloadRef`: the
question and the answer are usually different shapes. Each port emits a throw-on-invalid
parse and, where the language has the idiom, a result-style variant that does not throw. A
`template.output` gets no parser.

**Which parser for a raw model reply.** The strict parse expects the reply to *be* the JSON
document. A chat model's raw reply usually is not: `Sure!` followed by a fenced JSON block
fails it outright. Use the strict parse only when the provider guarantees a bare JSON body
(a structured-output or JSON mode). For a raw reply use the **tolerant extract**: it strips
prose and code fences, repairs what it can, and returns the data with a per-field report
(recovered / defaulted / lost / malformed) where the strict parse would throw. Check the
report's lost-required list, or call `orThrow` on the result in the ports that ship it, when
a lost `@required` field should be an error. The tolerant extract reads the live metadata, so
it takes a loaded root (or loader) as well as the text; its name and signature are in your
port's reference.

The strict tier is JSON-only. An `@responseFormat: xml` reply gets the tolerant extract and
nothing strict, because all-or-nothing semantics over a repairing XML reader would accept or
reject depending on how much repair happened.

## A responding `template.prompt` generates the response-format fragment

For the same templates codegen also emits a `render<Name>Format(...)`-shaped function: the
"produce your answer like this" fragment you splice into the prompt text so the model returns
the shape the parser expects. `@responseFormat` selects the syntax it teaches, and the
fragment and the extractor agree on the root name. It is generated from the response shape's
field tree, so it cannot fall out of step with that shape the way hand-written instructions
can: regenerate after a change.

`@promptStyle` controls its presentation:

| `@promptStyle` | Presentation |
|---|---|
| `guide` (default) | a prose field list ("Fill in each field…") followed by an example skeleton |
| `inline` | a single skeleton whose field values are inline placeholders / enum choices |
| `exampleOnly` | just a filled example skeleton, nothing else |

A field's `@example` fills its slot in the skeleton. With none, a string or number shows a
`{fieldName}` placeholder and an enum shows its allowed members
(`"urgency": "low | medium | high"`), never one pre-filled member, which a model would copy
into every reply. Guidance is rendered as text, never as code comments, because models
routinely ignore comments.

The JVM render module (Java, shared by Kotlin) also has `Verify.checkOutputPrompt(fragment,
requiredFieldNames)`, which asserts that a rendered fragment names every required field. Your
language reference says whether this port ships an equivalent.
