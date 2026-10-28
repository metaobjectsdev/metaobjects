# ADR-0061: A template body may use a per-port engine, chosen by its file

## Status

**Accepted** (2026-10-28). Registers no vocabulary: `metamodelVersion` stays `1.2`. It adds a
second template engine, Jinja, to the Python and TypeScript render tiers, plus the payload check
that goes with it. Mustache stays the default and the only engine in Java, Kotlin and C#.
Closes #483.

## Context

Every port renders `template.prompt` and `template.output` bodies with Mustache, and the
template gate (`verify`, plus the render-helper generator at codegen time) checks every
variable a body uses against the template's declared `@payloadRef` value object
(`ERR_VAR_NOT_ON_PAYLOAD`). Mustache is logic-less on purpose. That is why the check can be
exact, and it is also why the render corpus is byte-identical across five ports.

Teams with existing Jinja prompt templates, which are common in Python LLM stacks, could not
adopt the gate without first moving their template logic (filters, conditionals, `set`, macros,
includes) into the payload. Evaluators named this the largest migration cost for an AI-product
codebase (#483). The issue offered two options: Jinja as a second engine with the same
build-time check, at least in Python and TypeScript, or a Jinja-to-Mustache migration analyzer.
The ruling: "We should do some language specific options, I think we have that already. So
language specific templating is fine."

## Decision

1. **A second engine, Jinja, in Python and TypeScript.** Python renders with **jinja2**.
   TypeScript renders with **nunjucks**. Both are held to two shared corpora:
   `fixtures/jinja-render-conformance/` (rendered output, byte-identical between the two ports)
   and `fixtures/jinja-verify-conformance/` (the drift findings).

2. **The engine is chosen by the template FILE, never by the metadata.** A body is Jinja when
   its file has a `.jinja`, `.j2` or `.jinja2` extension, or when the caller passes an explicit
   `engine` (`render({ engine: "jinja" })`, `verify(text, fields, { engine: "jinja" })`, and
   the Python keyword equivalents). `@textRef` stays a logical `group/source` reference and the
   metamodel carries no engine attribute, so the portable vocabulary holds nothing that one
   port understands and another does not. A filesystem provider looks for `<ref>.mustache`
   first, then the Jinja extensions in the order above; a provider given one explicit extension
   reads only that extension. A provider that cannot tell (an in-memory map) reports nothing,
   and the body is Mustache unless the caller names the engine.

3. **The same payload check, at codegen time and at runtime.** The Jinja check walks the
   parsed template (the nunjucks AST in TypeScript, the jinja2 AST in Python), never the text:
   - a payload path (`user.name`, `user["name"]`) is checked segment by segment;
   - a `for` loop checks its iterable and binds the target to the element's fields;
   - `set`, macro parameters and loop targets are locals, not payload;
   - filters are not checked, but their arguments are, and a filter that names an element
     attribute (`map(attribute=…)`, `selectattr`, `join`, `sort`, `groupby`) has that name
     checked;
   - `include`, `import` and `extends` with a literal name are resolved through the provider
     and walked.

   Anything the check cannot settle without running the template (a dynamic subscript, a
   computed include name) is reported as **`ERR_TEMPLATE_NOT_STATIC`**. A body that does not
   parse is **`ERR_TEMPLATE_SYNTAX`**. Neither ever passes silently. `@requiredSlots` and
   `@requiredTags` apply to a Jinja body exactly as to a Mustache one. The render-helper
   generator runs this check at codegen time. A helper over a Jinja body passes the engine and
   the payload field tree to `render`, so `render` checks the body again when it runs. (Every
   TypeScript helper already passed the field tree. In Python only a Jinja helper does: a
   Mustache helper there relies on the codegen check alone, as before.)

4. **Mustache is unchanged.** It stays the default in every port. A project with no Jinja file
   gets byte-identical generated helpers, and the Mustache render corpus is untouched.

5. **Java, Kotlin and C# refuse Jinja by name.** Their filesystem providers (and the JVM
   classpath provider) throw a `RenderException` carrying **`ERR_TEMPLATE_ENGINE_UNSUPPORTED`**
   when a ref has only a Jinja file, or when the provider is configured with a Jinja extension.
   Their `verify` commands report it as a drift line on that template. Without this a Jinja
   body would be reported as an unresolved ref, or rendered as Mustache with its `{% %}` tags
   printed verbatim. Adding Jinja to these ports is out of scope.

6. **The dependency is optional in Python.** jinja2 is the `jinja` extra
   (`pip install metaobjects[jinja]`) and is imported only when a Jinja body is rendered or
   checked. In TypeScript, nunjucks is a dependency of `@metaobjectsdev/render`.

### Why nunjucks for TypeScript

nunjucks is BSD-2-Clause and is the long-standing JavaScript implementation of the Jinja
language. It is in maintenance mode, but its grammar is stable, which is what a build-time check
needs. It has `include`, `import` and `extends`, a walkable AST (`parser.parse`), and an escaping
hook, so each `@format`'s escaper (html, json, xml, text) applies to Jinja output exactly as it
does to Mustache output. `@huggingface/jinja` was considered and rejected: it has no `include`,
`import` or `extends`, and no escaping hook.

### What the two engines do not share

The corpora pin the shared vocabulary. Outside it, nunjucks and jinja2 differ, and a template
that must render the same in both ports should stay inside the corpus vocabulary:

- **Truthiness of an empty list.** jinja2 treats `[]` as false; nunjucks treats it as true. Use
  `{% if items | length %}`.
- **Printing a list or a dict** gives different text in each engine. Print its members.
- **Python-only syntax.** jinja2 accepts `{% with %}`, `namespace()` assignment, Python string
  methods (`name.upper()`) and `True`/`False`/`None`; nunjucks accepts `true`/`false`/`none`
  and JavaScript methods. The checker accepts a method call on a payload value and checks the
  receiver.
- **The Mustache-only payload accessors** (the injected `has<Field>` and `-first`/`-last` list
  flags) are not added for a Jinja body. Jinja has its own forms (`{% if field %}`, `loop.first`,
  `loop.last`).

Printed scalars are normalized in both ports to the Mustache renderer's form: `true`/`false`,
a whole float as an integer, and `None`/`undefined` as empty text.

## Consequences

- Jinja templates can adopt the gate unchanged. The migration cost in #483 drops to renaming a
  file, or to nothing for a file that already ends in `.jinja` or `.j2`.
- The render tier in Python and TypeScript now has two engines, and two corpora gate that
  pair. The cross-port Mustache corpus still gates all five ports.
- A model whose templates are Jinja renders in Python and TypeScript only. That is by design: the
  engine is a property of the port, and the refusal in the other three ports says so by code.
- The migration analyzer, the other option in #483, is not built.
