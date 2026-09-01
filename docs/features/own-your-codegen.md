# Own your codegen

MetaObjects treats generated code as a **disposable artifact** and the metamodel as
the **durable spine**. You own the generated code in your repo — it runs without any
MetaObjects runtime dependency, and if `@metaobjectsdev/*` (or the Maven/PyPI/NuGet
packages) disappeared, you keep working code.

"Own your codegen" means two related things, and how far each goes is **idiomatic per
port** — this is intentional (ADR-0035 §3, ratified), not a parity gap:

1. **You own the invocation** — codegen runs through your own build, on your terms,
   in every port.
2. **You own the templates** — in TypeScript, `meta init` scaffolds the reference
   generators *into your repo* so you can edit them (ADR-0034 scaffold-and-own). The
   JVM/Python/C# ports own codegen through **build configuration** rather than copied
   template files; template customization there is via the declarative
   template-codegen surface (`--template-spec` / Mustache) and the generator-selection
   SPI.

Either way, hand-edits inside a generated file survive regeneration — but *how* they
survive depends on what the toolchain can see, and it is worth knowing which case you
are in:

- **On the machine that generated the file**, `.metaobjects/.gen-state/` holds a full
  snapshot of what was last written, and `meta gen` does a real three-way merge: your
  edit and the new generated content are combined, and you only see a conflict when
  they touch the same lines.
- **Anywhere else** — a fresh clone, a teammate's checkout, CI — the snapshot bodies are
  gitignored and absent, so there is nothing to merge against. What *is* committed is
  `.gen-state/.hashes.json`, one hash per generated path. That is enough to tell a file
  nobody has touched (safe to regenerate) from one carrying an edit, and an edited file
  is **refused with its path named** rather than overwritten. On TypeScript a refusal
  fails the run (`meta gen` exits 1).

So on **TypeScript, Python and C#** the guarantee is *your edits are never silently
destroyed*; automatic merging is the stronger behaviour you get where the snapshot
exists (TypeScript only — the other two refuse rather than merge).

**Say the condition out loud, because it is where teams get surprised.** The merge is
machine-local. Edit a generated file, push it, and the *next* clone — a colleague's, a CI
runner's — has your file and its recorded hash but no snapshot body to merge against, so
`meta gen` refuses it and the build goes red on a file nothing is wrong with. The
generators that most invite an edit feel this first: a `requirementTests()` stub is
worthless until you write its body, so the moment it does its job it starts refusing
everywhere but the machine that generated it.

### Recovering a refused file on a machine that never generated it

Your version is intact on disk; nothing was lost. There is exactly one sequence that
keeps it, and it starts by **manufacturing the missing merge base** — which is why it is
not obvious:

```bash
git status                       # your edit must be COMMITTED before step 1 destroys it on disk
meta gen --baseline=fresh        # writes fresh output over the refused files AND seeds .gen-state
git checkout -- <the paths>      # your version back, with a snapshot base now present
meta gen                         # real three-way merge; reports `merged`, exit 0
```

To **discard** your version instead, `meta gen --baseline=fresh` on its own is the whole
answer.

The remedy you will not find here is *"move the edit into a non-generated file"*. It
works where the edit can live outside the generated file — and does not where the
artifact is the point of the edit. A `requirementTests()` stub is the standing
counterexample: its test name is the link back to the requirement and its own header
forbids renaming it, so the body has to stay where it is.

**Java and Kotlin implement the floor, not the detection — and the floor is a different
mechanism, not a weaker version of the same one.** Generated **source** on these ports —
the code MetaObjects authors — goes through `GeneratedFileWriter`, which reads the
existing file before writing and refuses it if it carries no `GENERATED` marker in its
header. That is the whole decision: there
is **no three-way merge** (TypeScript-only) and **no hash manifest**, so nothing here can
notice an edit to a file that still *has* its marker — such a file is overwritten.

**Four write paths bypass the guard on purpose**, and they are not oversights: user-supplied
templates (`TemplateScopeGenerator`, `MustacheTemplateGenerator`), the Maven docs goal's API
pages, and the `META-INF/services` registration whose entire content is a bare
fully-qualified name. None of them emits content MetaObjects authors, so none can be
required to carry a marker — guard one and run 1 writes it while every run after refuses
it, freezing the artifact behind a green build. `GeneratedFileWriter`'s javadoc lists them.

Two consequences to hold on to, because they invert the TypeScript answer:

- **Taking ownership is an explicit gesture: delete the marker line.** After that,
  regeneration never touches the file again. (On TypeScript, deleting the header buys you
  nothing — the write decision never reads it. There, ownership is what the hash manifest
  *observes*, not what the header declares.)
- **A refusal is a WARNING, not a build failure.** These generators run inside
  `mvn metaobjects:generate`, and failing the reactor over a file the user chose to own
  would punish the person the guard exists to protect. So a JVM build stays green while a
  refused file goes stale — watch the log. (On TypeScript a refusal exits 1.)

Two write paths deliberately **bypass** the guard, and the reason is the same in both:
the guard is sound only where our own emitter always writes the marker. `DocsMojo`'s API
pages render from `templates/api/*.mustache`, and `TemplateScopeGenerator` emits whatever
a user's `--template-spec` renders (SQL, markdown, CSV) — neither content is ours to
require a marker of, and guarding them would make the first run write and every run after
refuse, freezing the artifact while the build stayed green.

Edit detection is deliberately not replicated here, because these ports' customization
model is build-config and template-spec rather than editing emitted files in place (see
"Per port" below); the accuracy would cost a committed state file, a migration and a new
class of merge conflict on a workflow that does not ask for it.

Keep `.gen-state/.hashes.json` committed. Ignoring it is what turns the second case into
a silent overwrite, since a machine with neither a snapshot nor a hash cannot tell your
edit from its own output.

## The sibling module (`<Entity>.extra.ts`) is a convention, not a mechanism

Generated TypeScript files point at a sibling module for code metadata can't express, and
the pointer is good advice — but nothing in the toolchain implements it, and it is worth
knowing exactly what that means:

- **It is safe, but not because of its name.** `meta gen` writes only the paths it records
  in `.gen-state/.hashes.json`, and the orphan sweep deletes only from that same set. Any
  file you create in the output directory is untouched, whatever you call it. Renaming
  `Order.extra.ts` to `order-helpers.ts` changes nothing.
- **The generated barrel does not re-export it.** `index.ts` carries one
  `export * from "./<Entity>.js"` per object in the model, and it is built from that
  model rather than from a directory listing — deliberately, so generated output stays a
  pure function of your metadata instead of changing with whatever happens to be on disk.
  So importing from the barrel will not reach your sibling: **import it directly.**
- **Nothing discovers or overrides.** A handler or a replacement query in a sibling module
  runs only where your own code calls it.

Python's generated output carries the same pointer as `<Entity>_extra.py`, with the same
meaning.

## Per port

Every port offers the **declarative** path — a Mustache template plus a scope, no
generator code. Two ports ALSO offer a **programmatic** path, and two do not. Which
you get is the first thing to establish, because it changes what you can plan.

| Port | Invocation | Programmatic — write a `Generator` | Declarative — template + scope |
|---|---|---|---|
| **TypeScript** | `meta init` → `meta gen` (Bun/Node CLI) | **Yes — scaffold-and-own.** `meta init` copies `entityFile`/`queriesFile`/`routesFile`/`barrel` into `codegen/generators/*.ts`; `metaobjects.config.ts` imports those local copies. Edit them freely, or `meta eject <generator>` any other one. | **Yes** — `templateGenerator({ template, scope, outputPattern })` in the config's `generators: [...]`. No CLI flag: the config already takes generator values. |
| **Java / Kotlin** | `mvn metaobjects:generate` / `mvn metaobjects:verify` (`metaobjects-maven-plugin`) | **Yes.** Built-ins are selected in `pom.xml` by **stable name** through the `GeneratorRegistryProvider` ServiceLoader SPI; your OWN generator class is named in `<classname>` and loaded from the project classpath. Kotlin runs through the same goal. | **Yes** — `TemplateScopeGenerator` wired as an ordinary `<generator>`. No CLI flag: `<generator>` is already the seam. |
| **C#** | `dotnet meta gen` / `dotnet meta verify` (.NET tool) | **No.** `GeneratorRegistry` is a closed built-in registry; `--generators` *selects* from what ships. There is no registration seam. | **Yes, and it is your only path** — `dotnet meta gen --template-spec <json> --template-root <dir>`. |
| **Python** | `metaobjects gen` / `metaobjects verify` (console-script) | **No.** `GENERATOR_REGISTRY` is a closed built-in registry, same as C#. (`--provider module:symbol` registers **metamodel vocabulary**, not a generator — do not reach for it here.) | **Yes, and it is your only path** — `metaobjects gen --template-spec <json> --templates <dir>`. |

So "I need a shape the built-ins do not emit" has an answer on **every** port. On C# and
Python that answer is a template, not generator code — which is a real path, not a
consolation prize: it renders against the same neutral, byte-gated data dict every port
shares, so one template emits identically on all five.

**Choosing between the two paths** where you have both: reach for a template when the
output *shape* is what you are iterating on, or when you want the same output across
languages; reach for a generator when the logic is gnarly or the run is hot. Full
tradeoff table: [`codegen-concepts.md` §3](codegen-concepts.md).

**The spec file is discovered, not just flagged.** With no `--template-spec`, both ports
look for **`<projectRoot>/template-spec.json`** — projectRoot being the metadata dir's
parent, the same anchor `.metaobjects/` already uses. The flag overrides it.

That matters for more than typing: `verify --codegen` takes **no** `--template-spec` flag,
so discovery is how the drift gate learns about your template generators. Before it existed,
`gen` honoured the flag and `verify` never looked — so verify regenerated without them and
convicted their committed output, with a remedy that loops. Keep the spec at the
conventional path and both verbs resolve the same one.

Passing `--template-spec` explicitly still works and still wins; just make sure any CI that
runs `verify --codegen` can find the spec, which the conventional path guarantees and a
flag-only setup does not.

*(Full command/flag matrix and rationale: [`docs/features/cli.md`](cli.md), locked per
ADR-0015. Schema migrations are TypeScript-owned across all ports.)*

## What's shared vs. per-port

- **Shared (the durable contract):** the metamodel vocabulary, the canonical/YAML
  format, the wire/normalization contract, and the *shape* of the generated artifacts
  (verified byte-for-byte by the codegen + api-contract conformance corpora across all
  five ports). A given entity produces the same logical model, routes, and validation
  everywhere.
- **Per-port (idiomatic):** *how* you invoke codegen (npm CLI vs `dotnet` tool vs
  Maven goal vs console-script) and *how far* template ownership goes (TS copies
  editable templates into your repo; the other ports own codegen via build config +
  the declarative template surface). This split follows each ecosystem's norms
  rather than forcing a single mechanism.

## Reading a field's view: name the surface, never take the first

A field may declare several `view.*` children, one per surface it renders on. An owned
TS generator must select the one named for the surface it emits:

```ts
import { viewForContext } from "@metaobjectsdev/codegen-ts";

const view = viewForContext(field, "grid"); // "form", "grid", or your own surface name
```

`field.views()[0]` is the wrong read and reinstates a fixed bug: with several views the
first-declared one wins, so reordering two lines of JSON silently changes generated
output — and, because more than one generator reads the same list, one declaration ends
up driving unrelated surfaces at once. `viewForContext` returns the single view when a
field declares only one (so simple models are unaffected whatever that view is named),
and throws — naming the field, its views and the surface — when several are declared and
none is named for yours.

The packaged generators use `form` and `grid`; an owned generator rendering a third
surface passes its own name and tells its authors what to name.

## Custom types (custom providers)

Beyond owning the *generators*, you can extend the *metamodel itself* — register your
own type/subtype (a project-specific `view.*`, `field.*`, `validator.*`, …) through a
**consumer provider**. The metadata **loaders already accept consumer providers in
every language**: a runtime/library app that loads the metamodel plugs its provider in
and it merges on top of the core set. The only per-port question is how the **CLI /
build tool** hands that provider to the loader it already uses.

A provider carries **code**, not just declarations — a `factory` (how to construct the
node) plus an optional imperative validator. So the mechanism must load your **native
provider class** in each language: a JSON file could express the declarative surface
(types / attrs / child-rules) but not the factory or validator.

| Port | How the CLI / build tool loads your provider |
|---|---|
| **TypeScript** | `metaobjects.config.ts` → `providers: [myProvider]`. Threaded into `meta gen`, `meta verify`, `meta docs`, **and** the offline `meta migrate` paths (baseline + generate). |
| **Python** | `metaobjects gen \| verify \| docs --provider module:symbol` (repeatable). The symbol resolves to a `Provider` (or a list, or a zero-arg factory returning one) and is composed **on top of** the core providers — parity with TS `config.providers`. E.g. `metaobjects gen ./metaobjects --out ./gen --provider myapp.providers:view_provider`. A declarative `metaobjects.config.yaml` `providers:` list is also supported (resolved config-relative, no `PYTHONPATH=` — mirroring TS's config-file providers); see [`cli.md`](cli.md). |
| **Java / Kotlin** | Put your compiled `MetaDataTypeProvider` on the **project classpath** with a `META-INF/services/com.metaobjects.registry.MetaDataTypeProvider` entry. `metaobjects-maven-plugin` builds the loader with the project classloader, so **Java ServiceLoader auto-discovers it** — no plugin config needed. |
| **C#** | The loader accepts providers like every port; a first-class `dotnet meta` consumer-provider hook is tracked for a future release ([#158](https://github.com/metaobjectsdev/metaobjects/issues/158)). Today, extend the metamodel from an app that constructs the loader directly. |

This split follows each ecosystem's norms — interpreted ports (TS / Python) name or
import the provider module; compiled ports (JVM) discover it on the build classpath —
the same "idiomatic per port" principle as generator ownership (ADR-0035 §3).

## Deprecated (removed at 1.0)

Importing the built-in generators from `@metaobjectsdev/codegen-ts/generators`
(`entityFile`, `queriesFile`, `routesFile`, `barrel`) is **deprecated** (ADR-0034) and
**removed at the 1.0/8.0 release**. Use the owned copies `meta init` scaffolds into
`codegen/generators/*` and import those from your `metaobjects.config.ts`.
