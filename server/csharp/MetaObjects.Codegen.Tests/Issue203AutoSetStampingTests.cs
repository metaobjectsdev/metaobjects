// Issue #203 — the generated CRUD honors `field.timestamp @autoSet: onCreate|onUpdate`
// by stamping now() so adopters stop hand-writing created_at/updated_at in every repo.
//
// Contract (from the issue):
//   - insert stamps EVERY onCreate AND onUpdate column with now() (model value ignored —
//     a fresh row's updated_at == its created_at).
//   - update(model)/patch stamps onUpdate with now() and SKIPS onCreate (never rewriting
//     created_at — omitting this is the latent lost-update bug).
//   - patch stamps onUpdate BEFORE the caller's partial block (a partial still bumps it).
//   - InsertPreserving(model) — a verbatim escape hatch, emitted ONLY for entities with
//     @autoSet fields (import / restore / replication paths).
//   - now() is keyed off the COLUMN's temporal CLR type (generalizes beyond timestamp).
//
// The generated routes reference ASP.NET Core shared-framework types that are outside the
// in-memory Roslyn sandbox, so the full HTTP behavior lane lives in the api-contract corpus
// (owner-gated). These tests are (1) golden assertions on the emitted routes source and
// (2) a Roslyn compile+execute test of the EXACT emitted stamping expressions, proving the
// create-overwrites / update-preserves-created_at semantics as a runtime fact.

using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class Issue203AutoSetStampingTests
{
    // A vanilla entity: a @required non-autoSet field (title) drives the presence-checking
    // create handler, plus a @required @autoSet onCreate (createdAt) + onUpdate (updatedAt).
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Post", "children": [
        { "source.rdb": { "@table": "posts" } },
        { "field.long":      { "name": "id" } },
        { "field.string":    { "name": "title", "@required": true } },
        { "field.timestamp": { "name": "createdAt", "@required": true, "@autoSet": "onCreate" } },
        { "field.timestamp": { "name": "updatedAt", "@required": true, "@autoSet": "onUpdate" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    // A plain entity with NO @autoSet field (control — must be byte-identical to pre-#203).
    private const string PlainModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true } },
        { "field.timestamp": { "name": "createdAt" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    // @autoSet declared once on an abstract BaseEntity, inherited via extends — proves the
    // stamping keys off the RESOLVING @autoSet (ADR-0039), not an own-only read.
    private const string InheritedModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "BaseEntity", "abstract": true, "children": [
        { "field.long":      { "name": "id" } },
        { "field.timestamp": { "name": "createdAt", "@autoSet": "onCreate" } },
        { "field.timestamp": { "name": "updatedAt", "@autoSet": "onUpdate" } }
      ]}},
      { "object.entity": { "name": "Note", "extends": "BaseEntity", "children": [
        { "source.rdb": { "@table": "notes" } },
        { "field.string": { "name": "body" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    // now() keyed off the column temporal type: a field.date onCreate → DateOnly, a
    // field.timestamp @localTime onUpdate → DateTime (naive wall-clock).
    private const string TemporalModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Event", "children": [
        { "source.rdb": { "@table": "events" } },
        { "field.long":      { "name": "id" } },
        { "field.date":      { "name": "createdOn", "@autoSet": "onCreate" } },
        { "field.timestamp": { "name": "touchedAt", "@localTime": true, "@autoSet": "onUpdate" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "issue203.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    private static string Routes(string model) =>
        Assert.Single(new RoutesGenerator().Generate(Ctx(Load(model)))).Content;

    // -------------------------------------------------------------------------
    // Golden assertions on the emitted routes source
    // -------------------------------------------------------------------------

    [Fact]
    public void Create_stamps_every_onCreate_and_onUpdate_column_with_now()
    {
        var src = Routes(Model);
        // Both the onCreate (createdAt) AND onUpdate (updatedAt) columns are stamped on
        // insert — the model's value is ignored (fresh row: updated_at == created_at).
        Assert.Contains("input.CreatedAt = System.DateTimeOffset.UtcNow;", src);
        Assert.Contains("input.UpdatedAt = System.DateTimeOffset.UtcNow;", src);
        // Stamping happens BEFORE the row is persisted.
        var addIdx = src.IndexOf("db.Posts.Add(input);", System.StringComparison.Ordinal);
        Assert.True(addIdx > 0);
        Assert.True(src.IndexOf("input.CreatedAt = System.DateTimeOffset.UtcNow;", System.StringComparison.Ordinal) < addIdx);
        Assert.True(src.IndexOf("input.UpdatedAt = System.DateTimeOffset.UtcNow;", System.StringComparison.Ordinal) < addIdx);
    }

    [Fact]
    public void Create_required_key_presence_check_excludes_autoSet_fields()
    {
        var src = Routes(Model);
        // The @required non-autoSet field IS a required create key.
        Assert.Contains("foreach (var __req in new[] { \"title\" })", src);
        // A @required @autoSet field is server-filled → OPTIONAL on the wire (not a
        // required key), so an omitted createdAt/updatedAt is NOT a 400.
        Assert.DoesNotContain("\"createdAt\"", src);
        Assert.DoesNotContain("\"updatedAt\"", src);
    }

    [Fact]
    public void Update_stamps_onUpdate_with_now_and_never_rewrites_onCreate()
    {
        var src = Routes(Model);
        // onUpdate column is bumped on every update...
        Assert.Contains("existing.UpdatedAt = System.DateTimeOffset.UtcNow;", src);
        // ...but the onCreate column is NEVER stamped on update (the write-once created_at
        // contract — omitting this special-case is the latent lost-update bug).
        Assert.DoesNotContain("existing.CreatedAt =", src);
        // Stamped BEFORE the caller's partial merge block (so a partial still bumps it).
        var stampIdx = src.IndexOf("existing.UpdatedAt = System.DateTimeOffset.UtcNow;", System.StringComparison.Ordinal);
        var mergeIdx = src.IndexOf("foreach (var prop in body.RootElement.EnumerateObject())", System.StringComparison.Ordinal);
        Assert.True(stampIdx > 0 && mergeIdx > 0 && stampIdx < mergeIdx);
    }

    [Fact]
    public void Update_merge_loop_skips_every_autoSet_column()
    {
        var src = Routes(Model);
        // The caller can never set an @autoSet column via the PATCH/PUT body — both the
        // onCreate and onUpdate columns are skipped in the present-key merge.
        Assert.Contains("if (string.Equals(target.Name, \"CreatedAt\", System.StringComparison.Ordinal)) continue; // @autoSet: server-owned", src);
        Assert.Contains("if (string.Equals(target.Name, \"UpdatedAt\", System.StringComparison.Ordinal)) continue; // @autoSet: server-owned", src);
    }

    [Fact]
    public void InsertPreserving_escape_hatch_is_emitted_verbatim_for_autoSet_entity()
    {
        var src = Routes(Model);
        Assert.Contains("public static async System.Threading.Tasks.Task<Post> InsertPreserving(AppDbContext db, Post input)", src);
        // The escape hatch writes the @autoSet columns VERBATIM — it must NOT stamp now().
        var start = src.IndexOf("InsertPreserving(AppDbContext db, Post input)", System.StringComparison.Ordinal);
        Assert.True(start > 0);
        var body = src[start..];
        Assert.Contains("db.Posts.Add(input);", body);
        Assert.Contains("await db.SaveChangesAsync();", body);
        Assert.DoesNotContain("UtcNow", body);   // no stamping in the escape hatch
    }

    [Fact]
    public void Plain_entity_without_autoSet_gets_no_stamping_and_no_InsertPreserving()
    {
        var src = Routes(PlainModel);
        // No @autoSet field → byte-identical to pre-#203: no now() stamping anywhere,
        // and no escape hatch (there is nothing to preserve).
        Assert.DoesNotContain("UtcNow", src);
        Assert.DoesNotContain("InsertPreserving", src);
    }

    [Fact]
    public void AutoSet_resolves_through_extends_from_an_abstract_base()
    {
        // Note inherits createdAt/updatedAt (+ @autoSet) from BaseEntity via extends.
        var src = Assert.Single(
            new RoutesGenerator().Generate(Ctx(Load(InheritedModel)))
                .Where(f => f.Path == "NoteRoutes.g.cs"));
        var body = src.Content;
        Assert.Contains("input.CreatedAt = System.DateTimeOffset.UtcNow;", body);
        Assert.Contains("input.UpdatedAt = System.DateTimeOffset.UtcNow;", body);
        Assert.Contains("existing.UpdatedAt = System.DateTimeOffset.UtcNow;", body);
        Assert.DoesNotContain("existing.CreatedAt =", body);
        Assert.Contains("InsertPreserving(AppDbContext db, Note input)", body);
    }

    [Fact]
    public void Now_expression_is_keyed_off_the_column_temporal_type()
    {
        var src = Routes(TemporalModel);
        // field.date onCreate → DateOnly.FromDateTime(now).
        Assert.Contains("input.CreatedOn = System.DateOnly.FromDateTime(System.DateTime.UtcNow);", src);
        // field.timestamp @localTime onUpdate → DateTime (naive wall-clock) on both insert...
        Assert.Contains("input.TouchedAt = System.DateTime.Now;", src);
        // ...and update.
        Assert.Contains("existing.TouchedAt = System.DateTime.Now;", src);
    }

    // -------------------------------------------------------------------------
    // Behavior: compile + execute the EXACT emitted stamping expressions and assert the
    // create-overwrites / update-preserves-created_at runtime semantics.
    // -------------------------------------------------------------------------

    [Fact]
    public void Generated_stamping_expressions_execute_with_correct_runtime_semantics()
    {
        var src = Routes(Model);

        // Extract the exact stamping statements the generator emitted.
        var lines = src.Split('\n').Select(l => l.Trim()).ToList();
        var createStamps = lines.Where(l => l.StartsWith("input.") && l.Contains("UtcNow")).Distinct().ToList();
        var updateStamps = lines.Where(l => l.StartsWith("existing.") && l.Contains("UtcNow")).Distinct().ToList();
        Assert.Equal(2, createStamps.Count);   // CreatedAt + UpdatedAt
        Assert.Single(updateStamps);           // UpdatedAt only

        // A harness that runs those exact statements against a POCO shaped like the entity.
        var harness = $$"""
        public sealed class E
        {
            public System.DateTimeOffset? CreatedAt { get; set; }
            public System.DateTimeOffset? UpdatedAt { get; set; }
        }
        public static class H
        {
            public static void Create(E input) { {{string.Join(" ", createStamps)}} }
            public static void Update(E existing) { {{string.Join(" ", updateStamps)}} }
        }
        """;

        var asm = CompileAndLoad(harness);
        var eType = asm.GetType("E")!;
        var hType = asm.GetType("H")!;
        var created = eType.GetProperty("CreatedAt")!;
        var updated = eType.GetProperty("UpdatedAt")!;

        var past = System.DateTimeOffset.UtcNow.AddDays(-30);

        // insert — both columns overwritten to ~now (the model's stale values are ignored).
        var before = System.DateTimeOffset.UtcNow;
        var row = System.Activator.CreateInstance(eType)!;
        created.SetValue(row, past);
        updated.SetValue(row, past);
        hType.GetMethod("Create")!.Invoke(null, [row]);
        var after = System.DateTimeOffset.UtcNow;
        var cVal = (System.DateTimeOffset)created.GetValue(row)!;
        var uVal = (System.DateTimeOffset)updated.GetValue(row)!;
        Assert.True(cVal >= before && cVal <= after, "created_at stamped to now on insert");
        Assert.True(uVal >= before && uVal <= after, "updated_at stamped to now on insert");
        Assert.NotEqual(past, cVal);   // the stale model value was ignored

        // update — updated_at bumped, created_at LEFT UNCHANGED (the write-once contract).
        var row2 = System.Activator.CreateInstance(eType)!;
        created.SetValue(row2, past);
        updated.SetValue(row2, past);
        var beforeU = System.DateTimeOffset.UtcNow;
        hType.GetMethod("Update")!.Invoke(null, [row2]);
        var afterU = System.DateTimeOffset.UtcNow;
        Assert.Equal(past, (System.DateTimeOffset)created.GetValue(row2)!);   // NEVER rewritten
        var u2 = (System.DateTimeOffset)updated.GetValue(row2)!;
        Assert.True(u2 >= beforeU && u2 <= afterU, "updated_at bumped on update");
    }

    private static Assembly CompileAndLoad(string source)
    {
        var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp12));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("issue203_behavior_" + System.Guid.NewGuid().ToString("N"),
            [tree], refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var result = comp.Emit(ms);
        var errors = result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "harness should compile, got: " + string.Join("; ", errors));
        return Assembly.Load(ms.ToArray());
    }
}
