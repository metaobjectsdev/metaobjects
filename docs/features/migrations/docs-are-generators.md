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
named `docs`. These entries write the same pages to the same paths as the 1.0 project above:

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
| `docs.generators` (owned docs generators) | the owned copy, in `generators`, like any other owned copy |
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

**A generator you own.** A copy from `meta eject docs` (or `api-docs`, `requirements`,
`agent-docs`, `metamodel-docs`) goes in `generators`, in place of the packaged factory, like
any other owned copy. 1.0 listed it in `docs.generators`; that key is gone with the block.

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
