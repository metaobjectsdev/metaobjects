// TphM2mRoutesTests — FW-8: M:N traversal inside a TPH hierarchy (C# port).
//
// A TPH base's routes generator never consulted M2MNavigationBuilder at all — neither
// GenerateTphRoutes (the base + per-subtype CRUD emitter) nor AppendTphSubtypeRoutes
// asked the relation map a single question — so every many-to-many navigation declared
// anywhere in a TPH hierarchy vanished from the generated API. Nothing failed: a route
// that is never mounted is an ABSENCE, not a compile error, which is why the existing
// codegen-compile gate stayed green while the endpoint 404'd (and why
// CodegenCompileConformanceTests / IntegrationFixtureDriftTests deliberately exclude
// RoutesGenerator from what they compile — see those files' headers). This file
// exercises RoutesGenerator directly instead.
//
// Two independent gaps, both covered here:
//   A. the MISSING mounts (base-declared, subtype-declared, INHERITED through an
//      abstract mid level, and a non-subtype source whose M:N TARGET is a subtype) —
//      gated by string assertions against the generated routes file, mirroring the
//      existing M2MCodegenTests/TphCodegenTests convention of asserting on codegen
//      OUTPUT as a declared artifact;
//   B. a REAL compile defect once (A) is fixed naively: a M:N target that is a TPH
//      subtype has no DbSet of its own (DbContextGenerator.AppliesTo excludes TPH
//      subtypes), so binding to `db.<Pluralize(Target)>` names a property that does not
//      exist and the generated routes file fails to compile. `Full_model_compiles...`
//      below Roslyn-compiles Entity + DbContext + FilterAllowlist + Routes together
//      against EF Core 8 + ASP.NET Core, so a regression here is a build failure, not a
//      silent 404.
//
// Mirrors the TS reference model 1:1 (server/typescript/packages/codegen-ts/test/
// tph-m2m-routes.test.ts, from the commit that fixed the same two gaps in TypeScript)
// so the two ports are provably testing the same contract:
//   - Auth (TPH base) declares "tags" -> Tag through AuthTag                  (rule a)
//   - BridgeAuth (subtype) declares "linkedAuths", a directed self-join onto
//     itself through AuthLink — subtype-declared AND a subtype-typed M:N target
//     in one relationship                                                     (rule b/c + defect B)
//   - CopayAuth (subtype) declares nothing of its own; it still resolves "tags"
//     via extends                                                             (rule b, overlap with a)
//   - ScopedAuth (ABSTRACT mid level between Auth and PriorAuthAuth) declares
//     "auditors" -> Tag through AuthAudit — served nowhere but under the one
//     concrete subtype beneath it                                            (rule d)
//   - Payer (non-TPH source) declares "bridgeAuths" -> BridgeAuth through
//     PayerAuth — the target is a subtype, the source is not                  (defect B, no source gate)

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class TphM2mRoutesTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme::auth2", "children": [
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags2" } },
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
        { "source.rdb": { "@table": "auths2" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "type", "@values": ["Bridge", "Copay", "PriorAuth"] } },
        { "field.string": { "name": "reference", "@required": true, "@maxLength": 80 } },
        { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "AuthTag" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
        { "field.int": { "name": "quantity", "@required": true } },
        { "field.boolean": { "name": "verified", "@required": true, "@default": true } },
        { "relationship.association": { "name": "linkedAuths", "@cardinality": "many", "@objectRef": "BridgeAuth", "@through": "AuthLink", "@sourceRefField": "fromAuthId" } }
      ]}},
      { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
        { "field.int": { "name": "copayCents" } }
      ]}},
      { "object.entity": { "name": "ScopedAuth", "extends": "Auth", "abstract": true, "children": [
        { "relationship.association": { "name": "auditors", "@cardinality": "many", "@objectRef": "Tag", "@through": "AuthAudit" } }
      ]}},
      { "object.entity": { "name": "PriorAuthAuth", "extends": "ScopedAuth", "@discriminatorValue": "PriorAuth", "children": [
        { "field.string": { "name": "approver", "@maxLength": 80 } }
      ]}},
      { "object.entity": { "name": "AuthTag", "children": [
        { "source.rdb": { "@table": "auth_tags2" } },
        { "field.long": { "name": "authId", "@required": true } },
        { "field.long": { "name": "tagId", "@required": true } },
        { "identity.primary": { "@fields": ["authId", "tagId"] } },
        { "identity.reference": { "name": "fkAuth", "@fields": "authId", "@references": "Auth" } },
        { "identity.reference": { "name": "fkTag", "@fields": "tagId", "@references": "Tag" } }
      ]}},
      { "object.entity": { "name": "AuthLink", "children": [
        { "source.rdb": { "@table": "auth_links2" } },
        { "field.long": { "name": "fromAuthId", "@required": true } },
        { "field.long": { "name": "toAuthId", "@required": true } },
        { "identity.primary": { "@fields": ["fromAuthId", "toAuthId"] } },
        { "identity.reference": { "name": "fkFrom", "@fields": "fromAuthId", "@references": "BridgeAuth" } },
        { "identity.reference": { "name": "fkTo", "@fields": "toAuthId", "@references": "BridgeAuth" } }
      ]}},
      { "object.entity": { "name": "AuthAudit", "children": [
        { "source.rdb": { "@table": "auth_audits2" } },
        { "field.long": { "name": "auditAuthId", "@required": true } },
        { "field.long": { "name": "auditTagId", "@required": true } },
        { "identity.primary": { "@fields": ["auditAuthId", "auditTagId"] } },
        { "identity.reference": { "name": "fkAuditAuth", "@fields": "auditAuthId", "@references": "PriorAuthAuth" } },
        { "identity.reference": { "name": "fkAuditTag", "@fields": "auditTagId", "@references": "Tag" } }
      ]}},
      { "object.entity": { "name": "Payer", "children": [
        { "source.rdb": { "@table": "payers2" } },
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
        { "relationship.association": { "name": "bridgeAuths", "@cardinality": "many", "@objectRef": "BridgeAuth", "@through": "PayerAuth" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "PayerAuth", "children": [
        { "source.rdb": { "@table": "payer_auths2" } },
        { "field.long": { "name": "payerId", "@required": true } },
        { "field.long": { "name": "authId", "@required": true } },
        { "identity.primary": { "@fields": ["payerId", "authId"] } },
        { "identity.reference": { "name": "fkPayer", "@fields": "payerId", "@references": "Payer" } },
        { "identity.reference": { "name": "fkAuth", "@fields": "authId", "@references": "BridgeAuth" } }
      ]}}
    ]}}
    """;

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        // EmitAbstractShapes: true — ScopedAuth (the abstract TPH mid level between Auth
        // and PriorAuthAuth) is a real link in the C# inheritance chain
        // (`class PriorAuthAuth : ScopedAuth`); without its own emitted shape that
        // reference does not compile. A consumer with an abstract TPH intermediate level
        // needs this knob on regardless of these particular tests.
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal, EmitAbstractShapes = true },
    };

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "tph-m2m-routes.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static string FileContent(IEnumerable<EmittedFile> files, string path) =>
        files.Single(f => f.Path == path).Content;

    /// <summary>
    /// The full text of one `app.MapGet(prefix + "&lt;urlLiteral&gt;", ...` registration,
    /// found by matching braces from the call's opening `{` to its close — a lazy regex
    /// would stop at the first inner `}` (there are several: the symmetric/hetero arms,
    /// the empty-list early return). Throws with the whole file (truncated) if not found,
    /// so a failing assertion names what WAS generated.
    /// </summary>
    private static string ExtractMount(string src, string urlLiteral)
    {
        var marker = "app.MapGet(prefix + \"" + urlLiteral + "\"";
        var start = src.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0)
            throw new Xunit.Sdk.XunitException($"no mount for \"{urlLiteral}\" in:\n{src}");
        // Search from AFTER the marker, not from `start` — the route literal itself
        // contains a brace pair (e.g. "{id}"), which would otherwise be mistaken for the
        // lambda body's opening brace and desync the whole depth count.
        var braceStart = src.IndexOf('{', start + marker.Length);
        var depth = 0;
        var i = braceStart;
        for (; i < src.Length; i++)
        {
            if (src[i] == '{') depth++;
            else if (src[i] == '}') { depth--; if (depth == 0) { i++; break; } }
        }
        var end = src.IndexOf(");", i, StringComparison.Ordinal);
        return src[start..(end + 2)];
    }

    [Fact]
    public void Base_declared_m2m_mounts_at_base_path_with_no_source_gate()
    {
        var routes = FileContent(new RoutesGenerator().Generate(Ctx(Load())), "AuthRoutes.g.cs");
        var mount = ExtractMount(routes, "/auths/{id}/tags");
        // Every row of `auths` is a legitimate source for a base-declared relationship.
        Assert.DoesNotContain(".OfType<Auth>()", mount);
        Assert.Contains("db.AuthTags", mount);
        // The target is a plain entity (Tag), so it binds to its own DbSet directly.
        Assert.Contains("db.Tags.AsNoTracking()", mount);
    }

    [Fact]
    public void Subtype_declared_selfjoin_gates_the_source_and_binds_target_through_the_base()
    {
        var routes = FileContent(new RoutesGenerator().Generate(Ctx(Load())), "AuthRoutes.g.cs");
        var mount = ExtractMount(routes, "/auths/bridge/{id}/linkedAuths");
        // Rule c — the id in the URL must name a Bridge row before the junction is touched.
        Assert.Contains("if (!await db.Auths.OfType<BridgeAuth>().AnyAsync(x => x.Id == id))", mount);
        Assert.Contains("return Results.Ok(new System.Collections.Generic.List<BridgeAuth>());", mount);
        // Defect B — the self-join TARGET is the same subtype, which has no DbSet of its
        // own: the related rows must be loaded through the BASE DbSet, narrowed.
        Assert.Contains("await db.Auths.OfType<BridgeAuth>().AsNoTracking()", mount);
        Assert.DoesNotContain("db.BridgeAuths", mount);
    }

    [Fact]
    public void Inherited_m2m_is_served_at_the_base_and_under_every_concrete_subtype()
    {
        var routes = FileContent(new RoutesGenerator().Generate(Ctx(Load())), "AuthRoutes.g.cs");
        // "tags" is declared on Auth, so BridgeAuth/CopayAuth/PriorAuthAuth all resolve it
        // too (rule b) — the base mount plus one per subtype is FOUR mounts total. This is
        // the independent oracle's rule (expectedRoutes), which walks every SERVED
        // object's RESOLVED relationships, not an own-only read.
        var tagMounts = System.Text.RegularExpressions.Regex.Matches(routes, "\\{id\\}/tags\"").Count;
        Assert.Equal(4, tagMounts); // /auths, /auths/bridge, /auths/copay, /auths/priorauth
        var copayMount = ExtractMount(routes, "/auths/copay/{id}/tags");
        Assert.Contains("if (!await db.Auths.OfType<CopayAuth>().AnyAsync(x => x.Id == id))", copayMount);
        var priorAuthMount = ExtractMount(routes, "/auths/priorauth/{id}/tags");
        Assert.Contains("if (!await db.Auths.OfType<PriorAuthAuth>().AnyAsync(x => x.Id == id))", priorAuthMount);
    }

    [Fact]
    public void Abstract_mid_level_m2m_is_served_only_under_the_one_concrete_subtype_beneath_it()
    {
        var routes = FileContent(new RoutesGenerator().Generate(Ctx(Load())), "AuthRoutes.g.cs");
        // "auditors" lives on ScopedAuth — abstract, so it has no path and no rows of its
        // own, and it is not on the base either. The ONLY place it can be served is
        // beneath PriorAuthAuth, the one concrete subtype beneath that level.
        var mount = ExtractMount(routes, "/auths/priorauth/{id}/auditors");
        Assert.Contains("db.AuthAudits", mount);
        Assert.Contains("db.Tags.AsNoTracking()", mount);
        Assert.DoesNotContain("/auths/{id}/auditors\"", routes);
        Assert.DoesNotContain("/auths/bridge/{id}/auditors\"", routes);
        Assert.DoesNotContain("/auths/copay/{id}/auditors\"", routes);
    }

    [Fact]
    public void Nonsubtype_source_onto_a_subtype_target_binds_through_the_base_with_no_source_gate()
    {
        var routes = FileContent(new RoutesGenerator().Generate(Ctx(Load())), "PayerRoutes.g.cs");
        var mount = ExtractMount(routes, "/payers/{id}/bridgeAuths");
        // Payer itself is not a TPH participant — no subtype scoping on the source side.
        Assert.DoesNotContain(".OfType<Payer>()", mount);
        Assert.DoesNotContain("AnyAsync(x => x.Id == id))", mount);
        // Defect B — the target IS a subtype, so it must bind through the base + OfType.
        Assert.Contains("await db.Auths.OfType<BridgeAuth>().AsNoTracking()", mount);
        Assert.DoesNotContain("db.BridgeAuths", mount);
    }

    [Fact]
    public void Subtypes_still_emit_no_standalone_routes_file()
    {
        var files = new RoutesGenerator().Generate(Ctx(Load())).ToList();
        Assert.DoesNotContain(files, f => f.Path == "BridgeAuthRoutes.g.cs");
        Assert.DoesNotContain(files, f => f.Path == "CopayAuthRoutes.g.cs");
        Assert.DoesNotContain(files, f => f.Path == "PriorAuthAuthRoutes.g.cs");
        Assert.DoesNotContain(files, f => f.Path == "ScopedAuthRoutes.g.cs");
    }

    [Fact]
    public void Tph_subtype_required_field_with_default_gets_the_declared_initializer()
    {
        // Defect C — TphSubtypeScalarProperty never called DefaultInitializer, so a
        // @required + @default TPH subtype-only field silently started life at the CLR
        // default (false) instead of the declared @default value (true).
        var bridge = FileContent(new EntityGenerator().Generate(Ctx(Load())), "BridgeAuth.g.cs");
        Assert.Contains("public bool Verified { get; set; } = true;", bridge);
        // A required subtype field with NO @default is unaffected (no initializer).
        Assert.Contains("public int Quantity { get; set; }", bridge);
        Assert.DoesNotContain("public int Quantity { get; set; } = ", bridge);
    }

    [Fact]
    public void Full_model_compiles_against_ef_core_8_and_aspnetcore()
    {
        // The real regression guard for Defect B: RoutesGenerator's output is deliberately
        // excluded from CodegenCompileConformanceTests / IntegrationFixtureDriftTests (see
        // those files' headers), so a M:N-onto-a-TPH-subtype binding to a nonexistent DbSet
        // compiles clean everywhere else and only fails here, or in a live consumer's build.
        var ctx = Ctx(Load());
        var sources = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new FilterAllowlistGenerator().Generate(ctx))
            .Concat(new RoutesGenerator().Generate(ctx))
            .ToList();

        var trees = sources
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path))
            .ToList();

        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var tpa = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!;
        foreach (var p in tpa.Split(Path.PathSeparator)) if (p.Length > 0) paths.Add(p);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.DbContext).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.ModelBuilder).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.PrimaryKeyAttribute).Assembly.Location);
        // The routes file's `using MetaObjects.Codegen.Runtime;` (FilterParser,
        // EfCoreFilterDispatch) lives in this same assembly — a project reference, so it
        // is not on TRUSTED_PLATFORM_ASSEMBLIES.
        paths.Add(typeof(MetaObjects.Codegen.Runtime.FilterParser).Assembly.Location);
        var refs = paths.Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();

        var comp = CSharpCompilation.Create(
            "tph_m2m_routes_compile_" + Guid.NewGuid().ToString("N"), trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()} @ {d.Location}")
            .ToList();
        Assert.True(errors.Count == 0,
            "Generated TPH x M:N entity + DbContext + filter allowlist + routes should compile:\n" + string.Join("\n", errors));
    }
}
