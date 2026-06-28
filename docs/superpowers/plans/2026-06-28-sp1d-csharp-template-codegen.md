# SP-1d — C# declarative Mustache template-codegen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bring the declarative Mustache template generator (`scope` ∈ perEntity/perPackage/perModel + `outputPattern`, no walk code) to the C# port, expose it through a `--template-spec` JSON surface on `dotnet meta gen` (turning the no-op `template` registry primitive into a real consumer-usable generator), and gate byte-identical against the same `fixtures/template-codegen-conformance/` corpus the TS + JVM + Python ports pass. Last of the four SP-1 ports.

**Architecture:** Mirror the other ports in `MetaObjects.Codegen/TemplateCodegen/` — a `Dictionary<string,object?>`-based neutral data-dict builder (Stubble renders dictionaries) + an output-pattern expander + scope walks (`ScopeWalk.ForScope`) feeding the existing byte-equivalent `TemplateGenerator.Create`. Add a JSON template-spec parser + the `--template-spec` CLI flag (reusing `GenCommand`'s existing `templateRoot` plumbing for the `FilesystemProvider`). The C# Stubble render engine is already byte-equal (`fixtures/render-conformance/`), so only the data dict + scope + pattern are new.

**Tech Stack:** C# / .NET, `MetaObjects` (MetaObject/MetaField via `MetaDataLoader.FromDirectory`), `MetaObjects.Render` (Stubble + `FilesystemProvider`), `MetaObjects.Codegen` (`IGenerator`, `TemplateGenerator`, `CodegenRunner`), xUnit. Build/test: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter ...`.

## Global Constraints

- **Neutral data-dict keys = byte-gated cross-port contract**, identical to TS/JVM/Python: `name`, `package`, `fields[]` (`name`,`type`,`required`,`isArray`,`maxLength?`,`enumValues?`), `identities[]` (`kind`,`fields`), `relationships[]` (`name`,`cardinality`,`targetRef`). Use `Dictionary<string,object?>` (insertion-ordered) + `List<...>`; OMIT optional keys when absent. `type` = `field.SubType`; arrayness via `isArray` only.
- **Own-vs-effective discipline (BOTH rounds of the JVM+Python lesson, applied from the start):** `IsAbstract` per-node; `@required` attr + `maxLength` + identity `fields` + relationship `cardinality`/`objectRef` read via **`OwnAttr(...)`** (own-only, matching the TS oracle's ownAttr-backed getters); the required-**validator** branch effective; enum `values` via `Attr(...)` (effective). `o.Name` is bare; `o.Package` is null → effective package via `ResolutionKey()` (strip the trailing `::<Name>`).
- **Scope names** `perEntity`/`perPackage`/`perModel`; output-pattern grammar `{name}`/`{Name}`(PascalCase)/`{package}`(`::`→`/`); empty package collapses slash; unknown placeholder → throw.
- **TS is the byte-equality oracle** (`fixtures/template-codegen-conformance/expected/`); C# only READS it.
- **`target` is not supported** — `ParseTemplateSpec` REJECTS a per-generator `target` with a clear error (C# `EmittedFile.Path` is relative to a single out dir; same decision as Python). **Regen marker is the template author's responsibility** (the `@generated` overwrite guard is unchanged; document it). C# has NO package-init injection, so that Python concern does not apply.
- **Named constants** for metamodel strings where the codebase exposes them; **commit trailers** on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky`.
- **Public-repo hygiene**: no private names / absolute home paths in committed files.

## File Structure

- `MetaObjects.Codegen/TemplateCodegen/OutputPattern.cs` — `Expand(pattern, name, package)`.
- `MetaObjects.Codegen/TemplateCodegen/TemplateData.cs` — `Entity`/`Package`/`Model` builders + `BareName`/`PackageOf`/`IsConcrete`.
- `MetaObjects.Codegen/TemplateCodegen/ScopeWalk.cs` — `ForScope(scope, outputPattern) -> Func<MetaRoot, IEnumerable<TemplateWalkResult>>`.
- `MetaObjects.Codegen/TemplateCodegen/TemplateSpec.cs` — `ParseTemplateSpec(JsonElement)`, `ToGenerators(spec, IProvider)`.
- `MetaObjects.Cli/GenCommand.cs` + `Program.cs` — add `--template-spec <path>` (templateRoot already plumbed).
- Tests in `MetaObjects.Codegen.Tests/`: `OutputPatternTests.cs`, `TemplateDataTests.cs`, `TemplateSpecTests.cs`, `TemplateCodegenConformanceTests.cs`; a CLI test in `MetaObjects.Cli.Tests/`.

---

## Task 1: Output-pattern expander

**Files:** `OutputPattern.cs` + `OutputPatternTests.cs`.

- [ ] **Test** (mirror cross-port cases): `{package}/{name}Service.cs`+`order`/`acme::sales` → `acme/sales/orderService.cs`; `{Name}.cs`+`order_line` → `OrderLine.cs`; literal passthrough; empty package collapses; unknown placeholder throws `ArgumentException`; `{name}` with null name throws.
- [ ] **Implement** `public static string Expand(string pattern, string? name, string? package)` — `Regex.Replace` over `\{(\w+)\}`; PascalCase via split on non-alnum; collapse leading/duplicate `/` when package empty.
- [ ] **Run** `dotnet test MetaObjects.Codegen.Tests --filter FullyQualifiedName~OutputPatternTests` → PASS. **Commit.**

---

## Task 2: Neutral data-dict builder

**Files:** `TemplateData.cs` + `TemplateDataTests.cs`.

**Interfaces:**
```csharp
public static class TemplateData {
  public static string BareName(MetaObject o);          // o.Name (already bare)
  public static string PackageOf(MetaObject o);         // ResolutionKey() minus trailing "::Name"; "" if none
  public static bool IsConcrete(MetaObject o);          // !o.IsAbstract
  public static Dictionary<string,object?> Entity(MetaObject o);
  public static Dictionary<string,object?> Package(string pkg, IReadOnlyList<MetaObject> entities);
  public static Dictionary<string,object?> Model(IReadOnlyList<MetaObject> objects);  // concrete-only, pkgs sorted
}
```
Field dict (insertion order): `name`, `type`(`f.SubType`), `required`, `isArray`(`f.IsArray`), then `maxLength` (int — only if `o.OwnHasAttr("maxLength")`, value `Convert.ToInt32(OwnAttr("maxLength"))`), `enumValues` (only if `SubType=="enum"` and `Attr("values") is IEnumerable<string>` → `List<string>`). `required = OwnAttr("required") is true || OwnRequiredValidator`. Identity dict `{kind: SubType, fields: ((IEnumerable<string>)OwnAttr("fields")).ToList()}`. Relationship dict `{name: Name, cardinality: (string?)OwnAttr("cardinality") ?? "", targetRef: (string?)OwnAttr("objectRef") ?? ""}`.

> Implementer note: read identity `fields` and relationship `cardinality`/`objectRef` via `OwnAttr` (own-only) to match the TS oracle — the JVM+Python reviews both flagged the effective-vs-own divergence on these nodes. Use the typed `MetaIdentity.Fields`/`MetaRelationship.Cardinality` ONLY if you confirm they are own-only; otherwise `OwnAttr`.

- [ ] **Test** (load corpus via `MetaDataLoader.FromDirectory(corpus/"metadata").Root`, `root.Objects()`): Product `name=="Product"`/`package=="shop"`; name field `type=="string"`/`required==true`/`isArray==false`/`maxLength==120`; status `enumValues==["ACTIVE","ARCHIVED"]`; id has NO `maxLength`/`enumValues` keys; Order relationship `{product, one, Product}`; model one package `shop` with 2 entities.
- [ ] **Implement. Run → PASS. Commit.**

---

## Task 3: Scope walks

**Files:** `ScopeWalk.cs` (test via Task 4 conformance + a small unit test).

**Interface:** `public static Func<MetaRoot, IEnumerable<TemplateWalkResult>> ForScope(string scope, string outputPattern)`:
- `perEntity`: concrete `root.Objects()` → `new TemplateWalkResult(TemplateData.Entity(o), OutputPattern.Expand(pattern, TemplateData.BareName(o), TemplateData.PackageOf(o)))`.
- `perPackage`: group concrete by `PackageOf` (sorted) → `TemplateData.Package(pkg, list)` + `Expand(pattern, null, pkg)`.
- `perModel`: single → `TemplateData.Model(objects)` + `Expand(pattern, null, null)`.
- unknown scope → `ArgumentException`.

- [ ] **Implement + a unit test** asserting `ForScope("perEntity","{name}.txt")` over the corpus yields a result per concrete entity; unknown scope throws. **Run → PASS. Commit.**

---

## Task 4: JSON template-spec + `--template-spec` CLI

**Files:** `TemplateSpec.cs`; `GenCommand.cs` + `Program.cs`; `TemplateSpecTests.cs` + a `GenCommand` CLI test.

**Interfaces:**
```csharp
public sealed record TemplateSpecEntry(string Name, string Template, string Scope, string OutputPattern, string? Format, string? Target);
public static class TemplateSpec {
  public static IReadOnlyList<TemplateSpecEntry> Parse(JsonElement root);   // validates; throws on bad shape
  public static IReadOnlyList<IGenerator> ToGenerators(IReadOnlyList<TemplateSpecEntry> spec, IProvider provider);
}
```
`Parse`: require a `generators` array; each entry requires non-empty `name`/`template`/`scope`/`outputPattern`; `scope` ∈ the three; `format` (if present) ∈ the render formats; **reject `target` with a clear error** ("target is not supported by the C# port"). `ToGenerators` maps each → `TemplateGenerator.Create(name, template, ScopeWalk.ForScope(scope, outputPattern), provider, format ?? "text")`.

CLI: `dotnet meta gen ... --template-spec <path> [--template-root <dir>]` (reuse the existing `templateRoot`). In `GenCommand.Run`, when a spec path is set: parse it, build `new FilesystemProvider(templateRoot)`, append `TemplateSpec.ToGenerators(...)` to the resolved generator list before `CodegenRunner.Run`. A render-time failure (bad ref / wrong root) must surface as a clean CLI error + nonzero exit (catch the render exception type — confirm its name), not a stack trace.

- [ ] **Test `Parse`**: valid spec; unknown scope throws; missing `outputPattern` throws; bad `format` throws; **`target` present throws**; non-object throws. **Test `ToGenerators`** names. **CLI test**: a temp project run with `--template-spec` emits the template files; a bad template ref yields a clean error + nonzero exit.
- [ ] **Implement. Run → PASS. Commit.**

---

## Task 5: Conformance gate (shared corpus)

**Files:** `TemplateCodegenConformanceTests.cs`.

- [ ] **Test:** parse `spec.json`; `MetaDataLoader.FromDirectory(corpus/"metadata").Root`; `provider = new FilesystemProvider(corpus/"templates")`; `gens = TemplateSpec.ToGenerators(TemplateSpec.Parse(spec), provider)`; build a `GenContext { Entities = root.Objects(), Root = root, Config = <minimal> }`; for each gen, `gen.Generate(ctx)` into a temp dir; assert the emitted tree is byte-identical to `expected/`. Corpus dir found by walking up from `AppContext.BaseDirectory` to the dir containing `fixtures/`.
- [ ] **Run** `dotnet test MetaObjects.Codegen.Tests --filter FullyQualifiedName~TemplateCodegenConformanceTests`. If bytes differ, fix the data dict/pattern (NEVER edit `expected/`).
- [ ] **Run → PASS. Commit.**

---

## Task 6: Final verification

- [ ] `cd server/csharp && dotnet test MetaObjects.Codegen.Tests MetaObjects.Cli.Tests` — green (new tests + no regression). (A full `dotnet test MetaObjects.sln` if quick.)
- [ ] `git status` clean except new sources/tests; `fixtures/template-codegen-conformance/expected/` untouched.
- [ ] no-mistakes gate in an isolated worktree under the developer's home. All changes under `server/csharp/`, so the TS pre-push gate is skipped — but `bun install` up front so it can run if the no-mistakes internal repo lags origin (the SP-1b/1c lesson). `--skip=ci`; admin-merge after local green.

## Self-Review (against spec §3–§5)

- §3.1 scopes / §3.2 dict / §3.3 pattern / §3.4 provider / §3.5 corpus → Tasks 1–5, with the own-vs-effective discipline (both rounds) + the `target`-reject + clean-error decisions pre-applied from the JVM/Python reviews.
- §4 C# wiring → Task 4 (`--template-spec` JSON surface, shared Python/C# contract; reuses the existing `templateRoot`; turns the no-op `template` primitive real).
- §5 increment SP-1d → C# over the shared render engine, corpus-gated byte-identical to the TS oracle. Completes all four SP-1 ports. Out of scope: SP-2 native registration parity, SP-3 docs.
