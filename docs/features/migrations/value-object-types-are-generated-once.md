# Migration — a template's payload type is its value object's own type

**Applies to:** every project that generates template-tier code — render helpers, response
parsers, extractors, output-format fragments — in any port. **Action required:** regenerate,
update the imports and type names your own code uses, and wire the value-object generator
if you do not already. Metadata does not change.

Decision: [ADR-0056](../../../spec/decisions/ADR-0056-value-object-types-are-generated-once.md).
Fixes #387.

## What changed, and why it matters to you

A template names the shape it renders with `@payloadRef`, and a responding `template.prompt`
names the shape it parses with `@responseRef`. Both point at a value object. Every port used to
generate that shape TWICE: once as the value object's own type, and again as a template-named
copy (`<Template>Payload`, `<Template>Response`, `<Short>Payload`, `prompts.ts` interfaces)
written into the template's package.

The copies are gone. The value object's own type — emitted once, by the port's value-object
generator, at the value object's own location — IS the payload type and the response type. The
template tier imports it and declares nothing.

The copies were where the defects came from. In Java and Kotlin a nested value object shared by
templates in two packages was written into whichever package sorted first, and the other package
failed to compile against generated code (#387). Each copy also had its own field-type map,
nullability rule and enum naming, so "the same shape" disagreed with itself.

## What to do, in every port

1. **Wire the value-object generator** in every run that wires a template-tier generator. It
   is TS `entity`, C# `entity`, Java `value-object` (`SpringValueObjectGenerator`), Kotlin
   `entity` (`KotlinEntityGenerator`), Python `entity`. The template tier references its output.
2. **Remove the `payload` generator** from your configuration. It no longer exists:
   - C#: drop `payload` from `--generators`.
   - Python: drop `payload` from `--generators`.
   - Java: remove the `com.metaobjects.generator.spring.SpringPayloadGenerator` `<generator>`.
   - Kotlin: remove the `com.metaobjects.generator.kotlin.KotlinPayloadGenerator` `<generator>`.
3. **Regenerate**, then **delete the files that are no longer emitted.** A generator never
   deletes a file it stops writing. `meta verify --codegen` reports such a file as "committed
   but regen would not emit it". In TypeScript, a `prompts.ts` that held only value-object
   interfaces and no render handles is no longer emitted at all.
4. **Update your own code** to import the value object's type from where the value object
   lives, under the value object's name (below).

## Names and locations

A value object's type is named after the value object, never the template. Where the port
emits every value object into one flat namespace or directory (TypeScript, C#, Python), a value
object whose short name collides is package-qualified: `acme::alpha::Note` → `AcmeAlphaNote`.
Java and Kotlin keep `Note` in `acme.alpha`, because the package tells them apart.

| Port | Before | After |
|---|---|---|
| TypeScript | `interface Npc` re-declared in `prompts.ts`; parser returned `<Template>Data` | the `interface` `entityFile()` writes for the value object; the parser returns it |
| C# | `sealed record Npc` in `<Root>.payload.cs` | the `class Npc` POCO in `Npc.g.cs` |
| Java | `record NpcPromptPayload` / `NpcPromptResponse` in `<pkg>.prompts` | `record Npc` in the value object's package |
| Kotlin | `@Serializable data class NpcPromptPayload` / `NpcPromptResponse` in `<pkg>.prompts` | `data class Npc` in the value object's package |
| Python | `NpcPromptPayload` in `npc_prompt_payload.py`; `NpcPromptResponse` in `npc_prompt_response.py` | `class Npc(BaseModel)` in `Npc.py` |

The tolerant tier's all-nullable mirror is named after the value object too: `<Vo>Extracted`
(it was `<Template>Extracted` or `<Template>ResponseExtracted`).

## Port-specific changes

**TypeScript**
- An optional field is `name?: T`, as the value object declares it, not the old copy's
  `name?: T | null`. Coalesce a Drizzle row's `null` when you build a payload from it
  (`row.x ?? undefined`).
- Removed exports: `generatePayloadInterfaces`, `generatePayloadInterfacesBatch`,
  `generateRenderHandle`. `promptRender()` still emits the render handles.
- `prompt-render`, `output-parser`, `render-helper` and `trace-helper` declare
  `requires: ["entity"]`; a run without `entityFile()` warns.

**C#**
- The payload type is the entity tier's POCO: PascalCase properties with the metadata name in
  `[JsonPropertyName]`. The renderer reads it through those wire names, so templates do not
  change, and `{{#hasField}}` presence sections now work on a typed C# payload.
- Omitting a `@required` member when you construct a payload no longer fails to compile — POCO
  members are not `required`, because the REST tier shares the type. The strict parser still
  rejects a reply missing a `@required` field, through a generated `JsonTypeInfo` modifier.
- The extractor is named after the prompt: `<Prompt>Extractor` (was `<Vo>Extractor`).
- Each `<Vo>Extracted` mirror is its own `<Vo>Extracted.g.cs` file, emitted once per run.
- The output-format fragment's root name is the value object's short name (it could be a raw
  fully-qualified ref), so the rendered prompt text can change.

**Java**
- The generated `hasFoo()` methods are gone. The render engine derives `has<Field>` for a
  record payload itself, so `{{#hasFoo}}` still renders.
- The output-format `rootName` is the value object's short name (was the payload record's
  name), so the rendered prompt text changes.
- A template declared with no package emits into the root package. A packaged template whose
  payload names a root-package value object fails generation with a message: Java cannot import
  a root-package class into a named package.
- Wiring both `entity` (`JavaObjectCodeGenerator`) and `value-object` now collides on EVERY
  value object, not only the ones an entity jsonb column reaches. The collision guard names
  both generators; select one.
- `SpringValueObjectGenerator`'s records carry jakarta bean-validation constraints, so a
  template-only project needs `jakarta.validation-api` on the classpath.

**Kotlin**
- The strict parser decodes with Jackson (`jackson-module-kotlin`), not kotlinx.serialization,
  and throws `JsonProcessingException`. The value objects' data classes carry no
  `@Serializable`; no serialization compiler plugin is needed.
- The output-format `rootName` is the value object's short name — prompt text changes.
- `<Vo>Extracted.kt` is written once per run beside the value object and carries `fromMap` and
  `toStrict()`; the per-template mapper copies are gone. `toStrict()` maps an optional field as
  optional (the old extractor null-asserted every field).
- A template with no package emits into the root package, with the same root-package rule as
  Java.

**Python**
- Models come from the `entity` generator's `<Name>.py`. A value object whose short name
  another top-level object shares — a second value object, or an entity — is now
  package-qualified (`AcmeAlphaNote.py`); before, both wrote the same module.
- The request model no longer sets `extra="forbid"`, so a mistyped keyword argument is ignored
  rather than rejected. The model does carry the value object's declared validators
  (`validator.*`, `@maxLength`), which the copy did not, so construction enforces them.
- The render helper's `payload` parameter is typed as the `@payloadRef` model, and the render
  engine now renders a model payload. Before, it read mappings only, and a model payload
  rendered an empty body without an error.
- The output-format `root_name` is the value object's short name (was
  `<Template>Response`) — prompt text changes.
- `output-parser`, `extractor` and `render-helper` declare `requires: entity`: `gen --list`
  shows it and `--generators` warns when `entity` is missing.
- For generator subclassers: `ExtractorGenerator._emit_mapper(vo, root)` and the
  `extract_delegate_emitter` functions (`mirror_name`, `mapper_name`,
  `nested_mirror_dataclasses`, `nested_mappers`) lost their template-name and name-map
  parameters, and `RenderHelperGenerator._emit_document` / `_emit_email` gained a keyword-only
  `payload_class`. `collision_names.assign_nested_names` and
  `metaobjects.codegen.generators.payload_vo_generator` are removed; the resolver helpers
  moved to `metaobjects.codegen.value_objects`.
