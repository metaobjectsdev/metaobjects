// EntityGeneratorRound2Tests — round-2 extensibility hooks + two bug fixes + native
// @default initializers (open-closed, ADR-0002). Each test proves an adopter seam
// works (override changes output) OR a fix emits the right shape; the base
// (unsubclassed) generator stays byte-stable — the IntegrationFixture drift gate is
// the strong enforcer of that, these lock the new behavior.

using System.Linq;
using System.Text;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EntityGeneratorRound2Tests
{
    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "r2.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root, bool abstractShapes = false) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", EmitAbstractShapes = abstractShapes },
    };

    private static string File(System.Collections.Generic.IEnumerable<EmittedFile> files, string path) =>
        files.Single(f => f.Path == path).Content;

    // ----------------------------------------------------------------- items 2 + 3

    // Subclass overriding the two new round-2 hooks: an extra using + a class-body trailer.
    private sealed class HookedGenerator : EntityGenerator
    {
        protected override void EmitFileUsings(StringBuilder sb, MetaObject entity, GenContext ctx) =>
            sb.AppendLine("using Acme.Adopter;");

        protected override void EmitClassBodyTrailer(StringBuilder sb, MetaObject entity, GenContext ctx) =>
            sb.AppendLine("    public int Marker() => 42;");
    }

    private const string SimpleModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "email", "@required": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void EmitFileUsings_and_BodyTrailer_hooks_apply_and_base_is_unchanged()
    {
        var root = Load(SimpleModel);
        var hooked = File(new HookedGenerator().Generate(Ctx(root)), "Subscriber.g.cs");
        Assert.Contains("using Acme.Adopter;", hooked);
        Assert.Contains("public int Marker() => 42;", hooked);
        // The trailer lands inside the class body, before the closing brace.
        Assert.True(hooked.IndexOf("Marker()") < hooked.LastIndexOf("}"));

        var baseline = File(new EntityGenerator().Generate(Ctx(root)), "Subscriber.g.cs");
        Assert.DoesNotContain("Acme.Adopter", baseline);
        Assert.DoesNotContain("Marker()", baseline);
    }

    // ----------------------------------------------------------------- item 5

    // Subclass overriding the single declaration-line seam — a marker comment must show
    // up on ALL emitted class kinds (mapped entity, abstract shape, value-object POCO).
    private sealed class DeclMarkerGenerator : EntityGenerator
    {
        protected override void EmitClassDeclarationLine(
            StringBuilder sb, MetaObject entity, string className, ClassDeclarationKind kind, GenContext ctx)
        {
            sb.AppendLine("// adopter-decl");
            base.EmitClassDeclarationLine(sb, entity, className, kind, ctx);
        }
    }

    private const string MixedModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Money", "children": [
        { "field.long": { "name": "cents", "@required": true } }
      ]}},
      { "object.entity": { "name": "BaseThing", "abstract": true, "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long":   { "name": "id" } },
        { "field.object": { "name": "total", "@objectRef": "Money" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void EmitClassDeclarationLine_seam_reaches_all_class_kinds()
    {
        var root = Load(MixedModel);
        var files = new DeclMarkerGenerator().Generate(Ctx(root, abstractShapes: true)).ToList();
        Assert.Contains("// adopter-decl", File(files, "Order.g.cs"));      // mapped entity
        Assert.Contains("// adopter-decl", File(files, "BaseThing.g.cs"));  // abstract shape
        Assert.Contains("// adopter-decl", File(files, "Money.g.cs"));      // value-object POCO
    }

    // ----------------------------------------------------------------- item 4 (bug fix)

    [Fact]
    public void ObjectField_with_isArray_emits_a_collection_not_a_single_ref()
    {
        var model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "ContactInfo", "children": [
            { "field.string": { "name": "phone" } }
          ]}},
          { "object.entity": { "name": "Customer", "children": [
            { "source.rdb": { "@table": "customers" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "contacts", "@objectRef": "ContactInfo", "isArray": true } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var customer = File(new EntityGenerator().Generate(Ctx(Load(model))), "Customer.g.cs");
        Assert.Contains("public ICollection<ContactInfo> Contacts { get; set; } = new List<ContactInfo>();", customer);
        Assert.DoesNotContain("public ContactInfo? Contacts", customer);
    }

    // ----------------------------------------------------------------- item 6 (bug fix)

    [Fact]
    public void Callable_parameterRef_value_object_is_emitted_as_a_poco()
    {
        var model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "ReportArgs", "children": [
            { "field.long": { "name": "year", "@required": true } }
          ]}},
          { "object.entity": { "name": "ReportRow", "children": [
            { "source.rdb": { "@table": "fn_report", "@kind": "storedProc", "@parameterRef": "ReportArgs" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "label" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var files = new EntityGenerator().Generate(Ctx(Load(model))).ToList();
        // The args VO is referenced only via source.rdb @parameterRef (not an object-field),
        // yet its POCO must be emitted so the FR-015 callable wrapper compiles.
        var args = File(files, "ReportArgs.g.cs");
        Assert.Contains("public class ReportArgs", args);
        Assert.Contains("Year", args);
    }

    // ----------------------------------------------------------------- item A (native @default)

    [Fact]
    public void Literal_defaults_emit_property_initializers()
    {
        var model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Settings", "children": [
            { "source.rdb": { "@table": "settings" } },
            { "field.long":    { "name": "id" } },
            { "field.boolean": { "name": "active",  "@required": true, "@default": false } },
            { "field.int":     { "name": "retries", "@required": true, "@default": 3 } },
            { "field.long":    { "name": "big",      "@default": 5000000000 } },
            { "field.string":  { "name": "theme",   "@required": true, "@default": "dark" } },
            { "field.double":  { "name": "ratio",   "@default": 1.5 } },
            { "field.decimal": { "name": "rate",    "@precision": 10, "@scale": 2, "@default": "2.50" } },
            { "field.string":  { "name": "note" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var c = File(new EntityGenerator().Generate(Ctx(Load(model))), "Settings.g.cs");
        Assert.Contains("public bool Active { get; set; } = false;", c);
        Assert.Contains("public int Retries { get; set; } = 3;", c);
        Assert.Contains("public long? Big { get; set; } = 5000000000L;", c);
        Assert.Contains("public string Theme { get; set; } = \"dark\";", c);
        Assert.Contains("public double? Ratio { get; set; } = 1.5;", c);
        Assert.Contains("public decimal? Rate { get; set; } = 2.50m;", c);
        // A field without @default keeps the existing form (no initializer for a nullable string).
        Assert.Contains("public string? Note { get; set; }", c);
        Assert.DoesNotContain("Note { get; set; } =", c);
    }

    // ----------------------------------------------------------------- item 1 (promoted helpers)

    // A subclass reaching a now-`protected static` helper is a compile-level proof that
    // the per-property helpers are no longer private.
    private sealed class HelperReachingGenerator : EntityGenerator
    {
        public string CallScalar(MetaObject owner, MetaField field) =>
            ScalarProperty(owner, field, new[] { "id" }, withAttributes: false);
    }

    [Fact]
    public void Per_property_helpers_are_reachable_from_a_subclass()
    {
        var root = Load(SimpleModel);
        var order = root.Objects().Single(o => o.Name == "Subscriber");
        var email = order.Fields().Single(f => f.Name == "email");
        var line = new HelperReachingGenerator().CallScalar(order, email);
        Assert.Contains("public string Email", line);
    }
}
