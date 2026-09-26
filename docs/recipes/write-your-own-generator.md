# Write your own generator

MetaObjects is a core — the typed model, the loader and registry, `verify`, `migrate`,
prompt render and reply extract — and on that core **you build the generators your
application needs**: OpenAPI, JSON Schema, Zod, DTOs, a client, a service layer, docs,
anything the model describes. The generators MetaObjects ships are reference examples to
eject and modify, not the product
([ADR-0034 Amendment 4](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md#amendment-4-2026-09-26--write-your-own-generator-is-the-primary-path)).

A generator is small. It is a name plus a function from the loaded model to a list of
`{ path, content }` files. The runner writes them, and `verify --codegen` re-runs it and
fails the build when committed output is stale. You register nothing for that.

## When to write one

Write a generator when **the model fully describes an output and no reference generator
emits it**, or none emits it the way your application needs it:

- a document derived from the model: JSON Schema, OpenAPI, AsyncAPI, a GraphQL SDL, an ER
  diagram, a data dictionary;
- code derived from the model: a DTO or client layer for a framework nothing here ships,
  a service or repository layer in your house style, validators in another library, test
  fixtures, seed data shapes;
- config derived from the model: a search-index mapping, a permissions matrix, an
  analytics event catalog.

Hand-writing any of these is the anti-pattern: it drifts the day the model changes, and
nothing tells you. A generator regenerates on every model change and is drift-gated.

Reach for **`eject`** instead only when a reference generator already emits something
close to what you want (`meta gen --list` is the catalog); then edit your copy. Hand-write
only what the model genuinely cannot express: business logic, calls to other systems.

## The shape, in every port

Every example below was run end to end — generate, then `verify --codegen` clean, then a
model change that verify convicts. Each emits one text file per concrete object listing
its fields, inherited ones included.

### TypeScript — start with the scaffold

```bash
meta generator new field-list            # --scope entity (default) | package | model
meta gen                                 # runs it
meta verify --codegen                    # gates it
npx tsc -p tsconfig.codegen.json         # typechecks it (meta gen does not)
```

`meta generator new` writes `codegen/generators/field-list.ts` — a commented generator that
already runs and emits JSON describing each object — and adds its import and its entry to
`metaobjects.config.ts`. Edit the emit from there. The core of it is this:

```ts
import { isAbstract, perEntity, type Generator } from "@metaobjectsdev/codegen-ts";

export function fieldListGenerator(): Generator {
  return {
    name: "field-list",                          // shows in diagnostics
    filter: (obj) => !isAbstract(obj),           // ctx.entities has EVERY object, abstract ones too
    generate: perEntity((obj) => ({              // perPackage / perModel for other scopes
      path: `field-list/${obj.name}.txt`,        // relative to outDir
      content: obj.fields()                      // fields() includes inherited fields
        .map((f) => `${f.name}: ${f.subType}${f.resolvedIsArray() ? "[]" : ""}${f.isRequired ? "" : "?"}`)
        .join("\n") + "\n",
    })),
  };
}
```

Wire it by hand, if you did not use the scaffold: import it in `metaobjects.config.ts` and
add `fieldListGenerator()` to `generators: [...]`.

### Python

`codegen/generators/field_list.py` (with an empty `__init__.py` in `codegen/` and
`codegen/generators/`):

```python
from metaobjects.codegen.model_walk import EmittedFile, field_is_array, is_abstract, is_required, per_entity


class FieldList:
    name = "field-list"  # shows in diagnostics

    def filter(self, obj):  # ctx.entities is EVERY object, abstract bases included
        return not is_abstract(obj)

    def generate(self, ctx):
        def one(obj, _ctx):
            lines = [
                f"{f.name}: {f.sub_type}{'[]' if field_is_array(f) else ''}{'' if is_required(f) else '?'}"
                for f in obj.fields()  # fields() RESOLVES: inherited fields included
            ]
            return EmittedFile(path=f"field-list/{obj.name}.txt", content="\n".join(lines) + "\n")

        return per_entity(one)(ctx)


def field_list():  # the module:symbol target — a function returning the generator
    return FieldList()
```

```bash
metaobjects gen metaobjects --out gen --generators codegen.generators.field_list:field_list
metaobjects verify --codegen metaobjects --out gen --generators codegen.generators.field_list:field_list
```

or list `codegen.generators.field_list:field_list` under a target's `generators` in
`metaobjects.config.yaml`. The symbol must be the generator INSTANCE or a function
returning one — not the class: a class has a `generate` attribute, so it would be taken as
the generator itself. `metaobjects.codegen.model_walk` is the one import for model reads
(`is_required`, `max_length`, `field_is_array`, `enum_values`, `object_ref_target`,
`description`, `primary_key_fields`, `package_of`, `route_path`) — use it rather than
`field.attr(...)`, which is OWN-ONLY in Python and drops what a field inherits.

### C#

C# generators run from an owned console project, `codegen/`. `dotnet meta gen` and
`dotnet meta verify --codegen` hand off to it whenever `codegen/Codegen.csproj` exists.
`dotnet meta eject <name>` scaffolds that project; to start from none, write the two files:

`codegen/Codegen.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <!-- the version of your `dotnet meta` tool -->
    <PackageReference Include="MetaObjects.Codegen" Version="1.0.8" />
  </ItemGroup>
</Project>
```

`codegen/Program.cs`

```csharp
using Codegen.Generators;
using MetaObjects.Codegen;

IReadOnlyList<IGenerator> generators =
[
    new FieldListGenerator(),
];

return CodegenCli.Run(args, generators);
```

`codegen/generators/FieldListGenerator.cs`

```csharp
using MetaObjects.Codegen;

namespace Codegen.Generators;

public sealed class FieldListGenerator : IGenerator
{
    public string Name => "field-list";   // shows in diagnostics

    public IEnumerable<EmittedFile> Generate(GenContext ctx) =>
        ctx.Entities.Where(o => !o.IsAbstract)          // EVERY object arrives, abstract bases included
            .Select(o => new EmittedFile(
                $"field-list/{o.Name}.txt",
                // Fields() and ResolvedIsArray() RESOLVE through `extends`.
                string.Join("\n", o.Fields().Select(f => $"{f.Name}: {f.SubType}{(f.ResolvedIsArray() ? "[]" : "")}")) + "\n"));
}
```

```bash
dotnet meta gen metaobjects --out gen
dotnet meta verify --codegen metaobjects --out gen
```

An owned generator the `--generators` selection does not name still runs, so a project
with only generators of its own needs no `--generators` at all. Model reads:
`field.Attr(name)` resolves; `IsArray` is the own flag, `ResolvedIsArray()` resolves;
`field.EffectiveEnumValues`, `field.MaxLength`; `ValueObjectNames.ResolveFieldRef(field,
ctx.Root)` resolves an `@objectRef` package-locally; `CSharpNaming.RoutePath(obj)` is the
REST collection segment. Constants come from `using static
MetaObjects.Core.Field.FieldConstants;`.

### Java

In a codegen Maven module (the one `mvn metaobjects:eject` scaffolds, or any module the
plugin has as a `<dependency>`), extend `FileEmittingGenerator` and read the model through
`ModelWalk` — both in `metaobjects-codegen-base`:

```java
package com.acme.codegen;

import com.metaobjects.generator.FileEmittingGenerator;
import com.metaobjects.generator.ModelWalk;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

public class FieldListGenerator extends FileEmittingGenerator {
    @Override
    protected List<EmittedFile> generate(MetaDataLoader loader) {
        List<EmittedFile> out = new ArrayList<>();
        for (MetaObject o : ModelWalk.concreteObjects(loader)) {        // abstract bases skipped
            String body = ModelWalk.fields(o).stream()                   // inherited fields included
                .map(f -> f.getName() + ": " + f.getSubType() + (ModelWalk.isArray(f) ? "[]" : ""))
                .collect(Collectors.joining("\n"));
            out.add(new EmittedFile("field-list/" + ModelWalk.name(o) + ".txt", body + "\n"));
        }
        return out;
    }
}
```

```xml
<generator>
  <classname>com.acme.codegen.FieldListGenerator</classname>
  <args><outputDir>${project.basedir}/generated/field-list</outputDir></args>
</generator>
```

`mvn metaobjects:generate` runs it; `mvn metaobjects:verify` regenerates into a temp dir
and diffs. Extra `<args>` reach the generator through `getArg(name, default)`. Three JVM
traps `ModelWalk` exists to close: `getName()` is the fully-qualified `shop::Customer`
(use `ModelWalk.name`), `isArray()` is the own flag (use `ModelWalk.isArray`), and
`getMetaAttr(name, false)` is own-only. `ModelWalk.fields` lists an object's own fields
before inherited ones — the other ports list inherited fields first. Build output maps with
`LinkedHashMap`, never `Map.of`: its iteration order changes between JVM runs, and verify
would report drift that is not there.

### Kotlin

The same SPI, the same base class:

```kotlin
package com.acme.codegen

import com.metaobjects.generator.FileEmittingGenerator
import com.metaobjects.generator.ModelWalk
import com.metaobjects.loader.MetaDataLoader

class KtFieldListGenerator : FileEmittingGenerator() {
    override fun generate(loader: MetaDataLoader): List<EmittedFile> =
        ModelWalk.concreteObjects(loader).map { o ->                  // abstract bases skipped
            val body = ModelWalk.fields(o).joinToString("\n") { f ->   // inherited fields included
                "${f.name}: ${f.subType}${if (ModelWalk.isArray(f)) "[]" else ""}"
            }
            EmittedFile("field-list/${ModelWalk.name(o)}.txt", "$body\n")
        }
}
```

Wire it with `<classname>com.acme.codegen.KtFieldListGenerator</classname>` from a module
built with `kotlin-maven-plugin`.

## Reading the model correctly — the one rule

**Read through the resolving accessors.** `extends` is a reference to a parent, not a copy
of it, so what a field or object inherits lives on the parent and only the resolving reads
see it ([ADR-0039](../../spec/decisions/ADR-0039-own-accessor-discipline.md)). The own-only
forms compile, pass every fixture without inheritance, and are silently wrong on a real
model.

| | Resolving — use | Own-only — avoid |
|---|---|---|
| TypeScript | `fields()`, `attr(n)`, `isRequired`, `maxLength`, `resolvedIsArray()` | `ownFields()`, `ownAttr(n)`, the raw `isArray` |
| Python | `model_walk.*`, `node.attrs().get(n)`, `fields()` | `attr(n)` (own in Python), `own_fields()`, `is_array` |
| C# | `Fields()`, `Attr(n)`, `ResolvedIsArray()`, `EffectiveEnumValues` | `OwnFields()`, `OwnAttr(n)`, `IsArray`, `EnumValues` |
| Java / Kotlin | `ModelWalk.*`, `getMetaFields()`, `getMetaAttr(n)` | `getMetaAttr(n, false)`, `isArray()`, `getName()` for the bare name |

Two more reads every generator needs: which objects (the runner hands you every object,
abstract bases included, so filter) and the target of an `@objectRef` (resolve it with
the port's helper — `objectRefTarget` / `object_ref_target` / `ResolveFieldRef` /
`ModelWalk.objectRefTarget` — never by matching a short name, because two packages can
declare the same one).

TypeScript's public helpers for the rest: `enumValues`, `objectRefTarget`,
`effectivePackage`, `packageToPath`, `toCamelCase` / `toPascalCase` / `toSnakeCase` /
`pluralize`, `servedPath(obj, prefix)` (the address the reference routes serve), and the
predicates `isAbstract`, `hasAnyRdbSource`, `servesReadApi`, `servesWriteApi`,
`isProjection` — all from `@metaobjectsdev/codegen-ts`. The config's `apiPrefix` reaches a
generator as `ctx.renderContext?.apiPrefix`.

## Output: any format

`content` is the file as written — TypeScript, JSON, YAML, SQL, Markdown. No port formats
it or adds a header for you. On TypeScript, C# and Python a header is optional: the write
decision uses the committed `.metaobjects/.gen-state/.hashes.json`, so a JSON file is
protected like any other. On the JVM, `FileEmittingGenerator` routes a file whose content
carries the `GENERATED` header comment through the ownership guard and writes a file that
cannot carry one (JSON) as given.

Make output deterministic: the same model must produce the same bytes, or `verify` will
report drift on every run.

## Two worked examples: JSON Schema and OpenAPI 3.1

These are **examples to copy, not a supported product surface.** Nothing promises their
output across releases; the moment your API differs from the reference contract they
describe, edit your copy. Each is exercised by a test so it keeps running against the
current engine.

| Port | Files | Gated by |
|---|---|---|
| TypeScript | [`generators/typescript/json-schema.ts`](generators/typescript/json-schema.ts), [`openapi.ts`](generators/typescript/openapi.ts) | `cli/test/integration/recipe-generators.test.ts` (copied verbatim into a fresh `meta init` project, typechecked, generated, verified) |
| Python | [`generators/python/json_schema.py`](generators/python/json_schema.py) (both generators) | `server/python/tests/codegen/test_recipe_generators.py` |
| C# | [`generators/csharp/JsonSchemaGenerator.cs`](generators/csharp/JsonSchemaGenerator.cs) (both generators) | compiled into `MetaObjects.Codegen.Tests`, run by `RecipeGeneratorTests` |
| Java | [`generators/java/JsonSchemaGenerator.java`](generators/java/JsonSchemaGenerator.java), [`OpenApiGenerator.java`](generators/java/OpenApiGenerator.java) | `codegen-base` `RecipeGeneratorsCompileRunTest` |
| Kotlin | [`generators/kotlin/JsonSchemaGenerator.kt`](generators/kotlin/JsonSchemaGenerator.kt) (JSON Schema only) | `codegen-kotlin` `RecipeGeneratorCompileRunTest` |

The JSON Schema generator emits one draft 2020-12 schema per concrete object, following
the cross-port wire encodings (decimals as strings, currency as integer minor units,
temporals as ISO strings — [api-contract.md](../features/api-contract.md#type-encodings-tier-1-invariant)).
The OpenAPI generator emits one 3.1 document for the model: every concrete object as a
component schema, and the reference CRUD paths for each object with a source.

## See also

- [Own your codegen](../features/own-your-codegen.md) — ejecting a reference generator,
  and how each port protects hand edits.
- [Codegen concepts](../features/codegen-concepts.md) — scopes, programmatic vs Mustache
  generators, preserving hand edits.
