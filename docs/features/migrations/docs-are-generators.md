# Migration: documentation is a generator you declare

**Removed in:** 1.1.0 (Maven 8.1.0) · **Ports affected:** all five
**Automatic fix:** none. Each section below is written so you, or a coding agent working in
your repository, can make the change by hand.

## What changed

Through 1.0, documentation had a door of its own: `meta docs`, `dotnet meta docs`,
`metaobjects docs` and the Maven goal `metaobjects:docs`. Each wrote pages nobody listed,
from options of its own. In 1.1.0 there is one way to generate, in every port
(ADR-0034 Amendment 9):

- Every generator, documentation included, is an entry in your project's generator list,
  with its options in the entry.
- The gen command (Maven: `metaobjects:generate`) runs that list, and `verify` checks it.
- Nothing is written that the list does not declare.

The docs commands and the docs goal are removed. Running one prints the line that names
the gen command and this page. A gen run that still finds 1.0 docs configuration fails
before writing anything, so a build never passes while silently writing no documentation.

## TypeScript

**What you see.** `meta docs` fails (exit 2) with:

```
`meta docs` was removed in 1.1.0. `meta gen` writes documentation now: declare each docs generator in `generators` in metaobjects.config.ts. See docs/features/migrations/docs-are-generators.md, section "TypeScript".
```

`meta verify --docs` fails (exit 2) with:

```
`meta verify --docs` was removed in 1.1.0. `meta verify --codegen` checks documentation now, with everything else `generators` declares. See docs/features/migrations/docs-are-generators.md, section "TypeScript".
```

A config that still has a `docs` block fails `meta gen` and `meta verify --codegen` before
anything is written:

```
meta gen: found 1.0 docs configuration (the docs block in metaobjects.config.ts). Nothing reads it any more, so this run would write no documentation. Declare each docs generator in `generators` in metaobjects.config.ts. See docs/features/migrations/docs-are-generators.md, section "TypeScript".
```

**Before (1.0).** `meta docs` wrote four sets of pages nobody listed (the model pages, the
api reference, the requirement ledger and the agent pages) into `docs.outDir`, from a
`docs` block of its own:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "src/generated",
  dialect: "postgres",
  dbImport: "../db",
  generators: [entityFile(), routesFile()],
  docs: {
    outDir: "./docs/generated",
    layout: "package",
    apiSurfaces: [
      { lang: "ts", subDir: "api" },
      { lang: "java", subDir: "api/java", baseUrl: "https://docs.example.com/java" },
    ],
  },
});
```

```
meta gen
meta docs
meta docs --site
meta docs --metamodel
```

**After (1.1.0).** Each set of pages is a generator in `generators`, writing to a target
named `docs`. These entries write the 1.0 project's pages to the same paths (the site footer
and the metamodel page headers changed in 1.1.0, see below):

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import {
  agentDocsFile,
  apiDocsFile,
  docsFile,
  docsSiteFile,
  entityFile,
  metamodelDocsFile,
  requirementsFile,
  routesFile,
} from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "src/generated",
  dialect: "postgres",
  dbImport: "../db",
  targets: {
    docs: { outDir: "./docs/generated", outputLayout: "package" },
    // `meta docs --metamodel` wrote to ./docs/metamodel; keep that path with a target of its own.
    metamodel: { outDir: "./docs/metamodel" },
  },
  generators: [
    entityFile(),
    routesFile(),
    docsFile({
      apiSurfaces: [
        { lang: "ts", subDir: "api" },
        { lang: "java", subDir: "api/java", baseUrl: "https://docs.example.com/java" },
      ],
    }),
    apiDocsFile(),
    requirementsFile(),
    agentDocsFile(),
    docsSiteFile(),
    metamodelDocsFile({ target: "metamodel", subDir: "" }),
  ],
});
```

**The first run after the upgrade.** 1.0 wrote its pages without recording them in
`.metaobjects/.gen-state/.hashes.json`, so `meta gen` cannot tell them from pages somebody
edited, and refuses each one whose content changed. Run the docs entries once with a fresh
baseline, naming only the docs entries your config declares (this example declares all six):

```
meta gen --generators docs,api-docs,requirements,agent-docs,docs-site,metamodel-docs --baseline=fresh
```

This writes fresh pages over the 1.0 ones and records them. 1.0 overwrote these pages on every
`meta docs`, so nothing of yours is in them to lose. `--generators` keeps the fresh baseline
off your code: a generated code file you edited is still refused, not overwritten. Commit
`.metaobjects/.gen-state/.hashes.json` with the pages. From then on, run `meta gen`:

```
meta gen
```

List only the pages you want. 1.0 wrote the model pages, the api reference, the
requirement ledger and the agent pages on every `meta docs`; 1.1.0 writes exactly the
entries you list. The site and the metamodel reference were opt-in flags in 1.0, so list
them only if you ran those flags.

**Each 1.0 flag or key, and where it goes.**

| 1.0 (`meta docs` flag or `docs` key) | 1.1.0 |
|---|---|
| `docs.outDir`, `--out` (default `./docs/generated`) | `targets.docs.outDir` |
| `docs.layout`, `--layout` | `targets.docs.outputLayout` (falls back to the top-level `outputLayout`, as 1.0 did) |
| `docs.surfaces`, `--model` / `--api` / `--requirements` / `--agent` | which factories you list: `docsFile()`, `apiDocsFile()`, `requirementsFile()`, `agentDocsFile()` |
| `docs.apiSurfaces` | `docsFile({ apiSurfaces })`, same shape. Leave it out when the only api pages are this project's own: the model pages then link to whatever `apiDocsFile()` writes to the same target |
| the `subDir` of the `ts` entry in `docs.apiSurfaces` (default `api`) | `apiDocsFile({ subDir })`, same default |
| `docs.baseUrl`, `--base-url` | none: 1.0 read it nowhere. To link each api page to model pages hosted elsewhere, use `apiDocsFile({ modelBaseUrl })` |
| `--templates <dir>` | `docsFile({ templates: "<dir>" })` |
| `--site` | `docsSiteFile()`, writing to `site/` under the target |
| `--prompts <dir>` (with `--site`) | `docsSiteFile({ prompts: "<dir>" })` |
| `--scaffold-site` | `meta eject docs-site`, which copies the same files to the same place (`codegen/docs-site/`) |
| `--metamodel` | `metamodelDocsFile()`, writing to `metamodel/` under the target |
| `docs.generators` (owned docs generators) | a fresh copy from `meta eject <name> --force`, in `generators` (see "A generator you own") |
| `<project-root>` positional | run `meta gen` from that project, or with `--cwd <project-root>` |

**Things that are different in 1.1.0.**

- Every docs factory writes to the target named `docs` unless you give it `target`. A run
  that lists one while `targets` has no `docs` entry is refused, naming the generator:
  documentation is never written into the code's output directory by default.
- The site no longer prints today's date in its footer, so the pages depend on the model
  alone. Pass `docsSiteFile({ stamp: "<text>" })` for a stamp; a date there makes every
  day's run differ from the last one `meta verify --codegen` compares against.
- `meta verify --codegen` now checks the pages as it checks code. A page a fresh run no
  longer writes (the page of an object you removed) is drift until you delete it; `meta gen`
  does not delete it for you. A hand-written file in the docs directory is left alone.
- The site loads the same metadata `meta gen` loads, from the project's declared sources.

**Scripts and CI.** Replace `meta docs` with `meta gen`, and `meta verify --docs` with
`meta verify --codegen`. To write only the documentation, name the docs entries:

```
meta gen --generators docs,api-docs,requirements,agent-docs
```

`--generators` narrows a run to entries the config declares, by registry name (`meta gen
--list` prints them). A name the config does not declare is refused; it never adds a
generator.

If your repository git-ignores the docs directory, `meta verify --codegen` does not compare
its pages and names the directory on a line of its own, so a CI run that does not commit the
documentation still passes.

**A generator you own.** A copy from `meta eject docs` (or `api-docs`, `requirements`,
`agent-docs`, `metamodel-docs`) goes in `generators`, in place of the packaged factory, like
any other owned copy. 1.0 listed it in `docs.generators`; that key is gone with the block.

Do not move a 1.0 copy across as it is. It reads `ctx.docsDoor`, which 1.1.0 removed, so its
model pages and api pages no longer link to each other. Re-eject it with
`meta eject <name> --force` and make your edits again in the new copy. What changed in the
copy: `docsSurface` is gone, the link facts are on `ctx.docs`, the copy declares
`emitsModelDocs` or `emitsApiDocs` so the other generator can link to it, and it takes a
`target` option. A 1.0 copy left as it is still writes to the `docs` target, not into the
code's output directory, and is refused when `targets` has no `docs` entry.

**A project with no `metaobjects.config.ts`.** In 1.0, `meta docs` ran with no config at
all and wrote the model pages and the requirement ledger. In 1.1.0 nothing is generated
until a config declares it, and `meta gen` with no config fails with:

```
meta gen: no metaobjects.config.ts. Nothing is generated until a config declares it, documentation included; `meta init` writes one. A 1.0 project that ran `meta docs` with no config: see docs/features/migrations/docs-are-generators.md, section "TypeScript".
```

Write a `metaobjects.config.ts` at the project root with a `docs` target and `docsFile()`
(plus `requirementsFile()` when the model declares `requirement.*` nodes), and nothing else.
This writes the pages 1.0's bare `meta docs` wrote, to the same place:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { docsFile, requirementsFile } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "src/generated",
  targets: { docs: { outDir: "./docs/generated" } },
  generators: [docsFile(), requirementsFile()],
});
```

`outDir` is required by the config type and nothing writes there while no code generator is
listed. `requirementsFile()` writes nothing for a model that declares no `requirement.*`
node, so drop it if yours declares none. Then run `meta gen`.

## C#

**What you see.** `dotnet meta docs` prints this line and exits 2:

```
dotnet meta docs was removed in 1.1.0. `dotnet meta gen` writes documentation now: declare each docs generator in codegen/Generators.cs. See docs/features/migrations/docs-are-generators.md, section "C#".
```

`dotnet meta gen` (and `dotnet meta verify --codegen`) in a project with no
`codegen/Generators.cs` prints this and exits 2, writing nothing:

```
dotnet meta gen: no codegen/Generators.cs. The generator list lives there in 1.1.0, documentation included; `dotnet meta init` writes it. See docs/features/migrations/docs-are-generators.md, section "C#".
```

`dotnet meta gen` given `--project` or `--model-base-url` fails before writing anything,
with a line that starts `dotnet meta gen: found 1.0 docs configuration (` and names each
flag it was given.

**Before (1.0).** The code generators chosen on the command line, and the api reference
written by a second command:

```
dotnet meta gen ./metaobjects --out ./Generated --generators entity,db-context
dotnet meta docs ./metaobjects --out ./docs/generated --project shop --model-base-url https://docs.example.com/model
```

A project that had ejected a generator also had `codegen/Program.cs`, with the list inline:

```csharp
using Codegen.Generators;
using MetaObjects.Codegen;

IReadOnlyList<IGenerator> generators =
[
    new EntityGenerator(),
];

return CodegenCli.Run(args, generators);
```

and ran `dotnet meta gen ./metaobjects --out ./Generated --generators entity,db-context`, where
`--generators` added the packaged `db-context` to its own `entity`.

**After (1.1.0).** Run `dotnet meta init` once. It writes `codegen/Generators.cs`,
`codegen/Program.cs` and `codegen/Codegen.csproj`, each only when missing. Put every
generator in `codegen/Generators.cs`, the api reference included, with its options as init
properties. These entries write the same files to the same paths as the 1.0 commands above:

```csharp
// codegen/Generators.cs
using MetaObjects.Codegen;

public static class Generators
{
    public static IReadOnlyList<IGenerator> All { get; } =
    [
        new MetaObjects.Codegen.Generators.EntityGenerator(),
        new MetaObjects.Codegen.Generators.DbContextGenerator(),
        new MetaObjects.Codegen.Generators.ApiDocsGenerator
        {
            OutDir = "docs/generated",
            ProjectName = "shop",
            ModelBaseUrl = "https://docs.example.com/model",
        },
    ];
}
```

```csharp
// codegen/Program.cs
using MetaObjects.Codegen;
return CodegenCli.Run(args, Generators.All);
```

```
dotnet meta gen ./metaobjects --out ./Generated
```

A project that already has `codegen/Program.cs` with an inline list: move each entry into
`Generators.All`, add an entry for each name its `--generators` used to add (an owned copy is
`new Codegen.Generators.<Name>()`, a packaged one `new MetaObjects.Codegen.Generators.<Name>()`),
and replace `Program.cs` with the two lines above. `dotnet meta init` writes
`Generators.cs` beside an existing `Program.cs` and leaves `Program.cs` alone. Until
`Program.cs` runs `Generators.All`, `dotnet meta gen` prints this and exits 2, writing nothing
(`dotnet meta verify --codegen` in place of `dotnet meta gen` for the gate):

```
dotnet meta gen: codegen/Program.cs does not run Generators.All, so it would ignore the generator list in codegen/Generators.cs. Replace it with the two-line entry `using MetaObjects.Codegen;` and `return CodegenCli.Run(args, Generators.All);`. See docs/features/migrations/docs-are-generators.md, section "C#".
```

`init` and `eject` say the same, and warn when `codegen/Codegen.csproj` still pins an older
`MetaObjects.Codegen`: set that version to the tool's, or the 1.0 codegen runs.

**A template spec.** Through 1.0, `dotnet meta gen` and `verify --codegen` also read a
declarative template-spec on their own: `--template-spec <json>` on `gen`, or
`template-spec.json` at the project root (the metadata directory's parent) with no flag.
Neither is read in 1.1.0. A run that finds either, with no spec entry in the list, fails
before writing anything:

```
dotnet meta gen: found 1.0 template-spec configuration (template-spec.json). Nothing reads it any more, so this run would not render its templates. Declare it in codegen/Generators.cs as `new MetaObjects.Codegen.TemplateCodegen.TemplateSpecGenerator { Spec = "template-spec.json" }`. See docs/features/migrations/docs-are-generators.md, section "C#".
```

(`--template-spec` in place of `template-spec.json` when the flag was given;
`dotnet meta verify --codegen` in place of `dotnet meta gen` for the gate.)

Before (1.0):

```
dotnet meta gen ./metaobjects --out ./Generated --generators entity --template-root ./templates
# with ./template-spec.json beside ./metaobjects, or: --template-spec ./template-spec.json
```

After (1.1.0), the spec as one more entry; it writes the same files to the same paths:

```csharp
// codegen/Generators.cs
public static IReadOnlyList<IGenerator> All { get; } =
[
    new MetaObjects.Codegen.Generators.EntityGenerator(),
    new MetaObjects.Codegen.TemplateCodegen.TemplateSpecGenerator
    {
        Spec = "template-spec.json",
        TemplateRoot = "templates",
    },
];
```

```
dotnet meta gen ./metaobjects --out ./Generated
```

`Spec` and `TemplateRoot` are taken from the directory gen runs in, as `--out` is. Omit
`TemplateRoot` to keep the 1.0 default: `prompts/` when it exists, else `templates/`.

**Each 1.0 flag, and where it goes.**

| 1.0 | 1.1.0 |
|---|---|
| `dotnet meta gen --generators a,b,c` (the selection) | one entry per generator in `codegen/Generators.cs`; `--generators` now only narrows a run to declared entries, and naming one the list does not declare is refused |
| `dotnet meta docs --out <dir>` | `OutDir` on the `ApiDocsGenerator` entry, taken from the directory gen runs in, as `--out` is |
| `dotnet meta docs --project <name>` (default: the metadata directory's name) | `ProjectName`, default `project`; set the metadata directory's name to keep 1.0's pages byte for byte |
| `dotnet meta docs --model-base-url <url>` | `ModelBaseUrl` |
| the `api/csharp` subdirectory under `--out` | `ApiSubDir`, same default |
| `dotnet meta gen --template-spec <json>`, or a project-root `template-spec.json` | a `TemplateSpecGenerator { Spec = "<json>" }` entry |
| `dotnet meta gen --template-root <dir>` | `TemplateRoot` on the spec entry, and the template root `render-helper` is constructed with in the list |
| `dotnet meta docs --namespace <ns>` | the gen run's `--namespace`, as before |
| whether you ran `dotnet meta docs` | whether `ApiDocsGenerator` is listed |
| an owned api-docs copy, run by `dotnet meta docs` (1.1.0 release candidates only) | `new Codegen.Generators.ApiDocsGenerator { ... }` in the list, in place of the packaged one |

**Give the api-docs entry an `OutDir` that holds generated files only.**
`dotnet meta verify --codegen` now checks the pages, as it checks code: it regenerates each
entry's `OutDir` and compares the whole tree, so a hand-written file there reads as stale.

**Scripts and CI.** Replace `dotnet meta docs ...` with `dotnet meta gen`. To write only the
documentation, name the docs entry:

```
dotnet meta gen ./metaobjects --out ./Generated --generators api-docs
```

Drop `--generators` from a `dotnet meta gen` or `verify --codegen` line that used it to choose
the generators: the list chooses them now.

## Python

**What you see.** `metaobjects docs` prints this line and exits 2:

```
metaobjects docs was removed in 1.1.0. `metaobjects gen` writes documentation now: declare each docs generator in a target's `generators` in metaobjects.config.yaml. See docs/features/migrations/docs-are-generators.md, section "Python".
```

`metaobjects gen` (and `metaobjects verify --codegen`) with no `metaobjects.config.yaml`
prints this and exits 2, writing nothing. That includes the 1.0 form
`metaobjects gen <metadata_dir> --out <dir> --generators <names>`:

```
metaobjects gen: no metaobjects.config.yaml. The generator list lives there in 1.1.0, documentation included. See docs/features/migrations/docs-are-generators.md, section "Python".
```

A config that still has a top-level `docs` block fails `gen` before it writes anything:

```
metaobjects gen: found 1.0 docs configuration (the docs block in metaobjects.config.yaml). Nothing reads it any more, so this run would write no documentation. Declare each docs generator in a target's `generators` in metaobjects.config.yaml. See docs/features/migrations/docs-are-generators.md, section "Python".
```

**Before (1.0).** Code from a config file, or from flags with no config, and the api
reference from a second command:

```yaml
# metaobjects.config.yaml
targets:
  api:
    outDir: src/generated
    generators: [entity, filter-allowlist, routes]
```

```
metaobjects gen
metaobjects docs --out docs/generated --project shop --model-base-url https://docs.example.com/model
```

or, with no config:

```
metaobjects gen ./metaobjects --out src/generated --generators entity,filter-allowlist,routes
```

**After (1.1.0).** One config file lists every generator, the api reference included, each
in the target whose `outDir` it writes into. The api reference's options are the top-level
`apiDocs` block. This file writes the same files to the same paths as the 1.0 commands above:

```yaml
# metaobjects.config.yaml
metadata: metaobjects
targets:
  api:
    outDir: src/generated
    generators: [entity, filter-allowlist, routes]
  docs:
    outDir: docs/generated
    generators: [api-docs]   # an owned copy: "codegen.generators.api_docs_generator:api_docs_generator"
apiDocs:
  projectName: shop
  modelBaseUrl: https://docs.example.com/model
```

```
metaobjects gen
```

**Each 1.0 flag or key, and where it goes.**

| 1.0 | 1.1.0 |
|---|---|
| `metaobjects docs --out <dir>` | `outDir` of the target that lists `api-docs` |
| `metaobjects docs --api-subdir <dir>` (default `api/python`) | `apiDocs.apiSubDir`, same default |
| `metaobjects docs --project <name>` (default: the name of the directory `docs` ran in, or of `<metadata_dir>` when given) | `apiDocs.projectName`, default `project`; set that name to keep 1.0's pages byte for byte |
| `metaobjects docs --model-base-url <url>` | `apiDocs.modelBaseUrl` |
| `metaobjects docs --provider <module:symbol>` | top-level `providers` (`--provider` on `gen` still adds one) |
| whether you ran `metaobjects docs` | whether a target lists `api-docs` |
| `docs.generators` (an owned api-docs copy; 1.1.0 release candidates only) | the owned `module:symbol` in a target's `generators`, in place of `api-docs` |
| `gen <metadata_dir>` | top-level `metadata` |
| `gen --out <dir>` | the target's `outDir` |
| `gen --generators a,b,c` (the selection) | the target's `generators`; `--generators` now only narrows a run to declared entries, and naming one no target declares is refused |
| `gen --template-spec <json>`, or the `template-spec.json` beside `<metadata_dir>` that 1.0 found on its own | `templateSpec: <json>` on the target its output belongs in; a leftover `template-spec.json` that no target declares fails the run with a line that starts `metaobjects gen: found 1.0 template-spec configuration (` |
| `gen --entities a,b` | the target's `entities` (`--entities` still narrows a run) |

**Give the docs target an `outDir` that holds generated files only.**
`metaobjects verify --codegen` now checks the pages, as it checks code: it regenerates each
target's `outDir` and compares the files it would write.

**Scripts and CI.** Replace `metaobjects docs ...` with `metaobjects gen`, and
`metaobjects gen <metadata_dir> --out <dir> ...` with `metaobjects gen` once the config
declares the list. To write only the documentation, name the docs entry (or its target):

```
metaobjects gen --generators api-docs
metaobjects gen --target docs
```

## Java and Kotlin

**What you see.** A pom that binds the `docs` goal fails with:

```
metaobjects:docs was removed in 8.1.0. `mvn metaobjects:generate` writes documentation now: declare each docs generator as a <generator> entry in the plugin's <generators>. See docs/features/migrations/docs-are-generators.md, section "Java and Kotlin".
```

A pom that still sets the goal's parameters fails in `generate` and `verify` with a line
that starts `metaobjects:generate: found 1.0 docs configuration (` and names each element
it found.

**Before (8.0).** The `docs` goal, with its parameters in the plugin's `<configuration>`:

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <loader>...</loader>
    <outputDirectory>${project.build.directory}/docs</outputDirectory>
    <language>java,kotlin</language>
    <layout>package</layout>
    <modelBaseUrl>https://docs.example.com/model</modelBaseUrl>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.spring.SpringDtoGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
      </generator>
    </generators>
  </configuration>
  <executions>
    <execution>
      <goals>
        <goal>generate</goal>
        <goal>docs</goal>
      </goals>
    </execution>
  </executions>
</plugin>
```

**After (8.1.0).** One `<generator>` entry per language, in the same list as your code
generators; the `docs` goal and its parameters are gone. These entries write the same pages
to the same paths as the 8.0 pom above:

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <loader>...</loader>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.spring.SpringDtoGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.apidocs.JavaApiDocsGenerator</classname>
        <args>
          <outputDir>${project.build.directory}/docs</outputDir>
          <layout>package</layout>
          <projectName>${project.artifactId}</projectName>
          <modelBaseUrl>https://docs.example.com/model</modelBaseUrl>
        </args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsGenerator</classname>
        <args>
          <outputDir>${project.build.directory}/docs</outputDir>
          <layout>package</layout>
          <projectName>${project.artifactId}</projectName>
          <modelBaseUrl>https://docs.example.com/model</modelBaseUrl>
        </args>
      </generator>
    </generators>
  </configuration>
  <executions>
    <execution>
      <goals>
        <goal>generate</goal>
      </goals>
    </execution>
  </executions>
</plugin>
```

**Each 8.0 parameter, and where it goes.**

| 8.0 (`metaobjects:docs`) | 8.1.0 (`<args>` of the api-docs entry) |
|---|---|
| `<outputDirectory>` (default `${project.build.directory}/docs`) | `outputDir`, required |
| `<language>` (default `java`) | which entries you list: `JavaApiDocsGenerator` for `java`, `KotlinApiDocsGenerator` for `kotlin` |
| `<apiSubDir>` (default `api/<language>`) | `apiSubDir`, same default per generator |
| `<layout>` (default `flat`) | `layout`, same default |
| `<modelBaseUrl>` | `modelBaseUrl` |
| the page header's project label, which was the module's `artifactId` | `projectName`, default `project`; set `${project.artifactId}` to keep 8.0's pages byte for byte |
| `-Dmetaobjects.docs.*` properties | none; use Maven properties inside `<args>` if you need to override from the command line |

**Give each api-docs entry an `outputDir` that holds generated files only.**
`metaobjects:verify` now checks the pages, as it checks code: it regenerates each entry's
`outputDir` and compares the whole tree, so a hand-written file there reads as stale.

**Scripts and CI.** Replace `mvn metaobjects:docs` with `mvn metaobjects:generate`. To write
only the documentation, give it an execution of its own and run that one:

```xml
<execution>
  <id>docs</id>
  <goals><goal>generate</goal></goals>
  <configuration>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.apidocs.JavaApiDocsGenerator</classname>
        <args><outputDir>${project.build.directory}/docs</outputDir></args>
      </generator>
    </generators>
  </configuration>
</execution>
```

```
mvn metaobjects:generate@docs
```

**A generator you own.** An owned api-docs copy (`mvn metaobjects:eject -Dnames=api-docs`)
is listed by its own class name in `<generators>`, in place of the packaged one. 8.0 had no
other place to list it.

**Java `entity` no longer writes extractors.** Through 8.0 the `entity` generator
(`JavaObjectCodeGenerator`) also wrote a `<Name>Extractor` beside each class when the pom
listed no `extractor`. In 8.1.0 only the `extractor` entry writes them. If your code calls
`<Name>Extractor.extract(...)` and your pom lists `entity` without `extractor`, add:

```xml
<generator>
  <classname>com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator</classname>
  <args>
    <outputDir>(the entity entry's outputDir)</outputDir>
  </args>
</generator>
```

Give it the same naming args (`pkgPrefix`, `pkgSuffix`, `namePrefix`, `nameSuffix`) and
`<filters>` as the `entity` entry, so each extractor lands beside its class as before.

**Unchanged.** Poms that list `plantuml`, `html-docs` or `ai-docs` already declared them as
`<generator>` entries and need nothing.
