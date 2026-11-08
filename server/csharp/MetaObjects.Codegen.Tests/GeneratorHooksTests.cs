// GeneratorHooksTests — the fine-grained emit hooks on DbContextGenerator and EntityGenerator.
//
// An adopter that needs one line of generated output different overrides ONE small hook, calls
// base, and adjusts what it returns — instead of regex surgery over the finished file or a
// whole-body re-emit. Three families:
//
//   * Default_output_is_unchanged        — a subclass overriding nothing is byte-identical to the
//                                          stock generator (the existing snapshot suite, which
//                                          passes untouched, is the other half of that proof).
//   * <Hook>_is_called_for_every_<x>     — a recording subclass sees every element the hook
//                                          emits, over a model with a TPH hierarchy, a flattened
//                                          value object, a jsonb value object, an enum array and
//                                          a self-reference.
//   * Override_of_<Hook>_changes_only_its_lines — an override moves exactly the lines that hook
//                                          owns and nothing else.
//
// Lines hooks return are complete OnModelCreating lines (8-space indent included), the same form
// the generator keeps them in, so a hook's result can be added to the body as it stands.

using System.Text;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class GeneratorHooksTests
{
    // Auth is a TPH base (BridgeAuth its subtype) that carries: an enum, an enum array, a flattened
    // value object, a jsonb value object, a map, a @dbColumnType column, a @default, a decimal, a
    // timestamp and a reference to ITSELF (parentId -> Auth). BridgeAuth adds its own enum array,
    // flattened value object and default.
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street", "@required": true, "@maxLength": 120 } },
        { "field.enum":   { "name": "kind",   "@values": ["HOME", "WORK"] } }
      ]}},
      { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
        { "source.rdb": { "@table": "auths" } },
        { "field.long":   { "name": "id" } },
        { "field.enum":   { "name": "type", "@values": ["Bridge", "Plain"] } },
        { "field.string": { "name": "reference", "@required": true, "@maxLength": 80 } },
        { "field.string": { "name": "note", "@maxLength": 80 } },
        { "field.string": { "name": "uid", "@dbColumnType": "uuid" } },
        { "field.boolean": { "name": "active", "@default": true } },
        { "field.decimal": { "name": "amount", "@precision": 10, "@scale": 2 } },
        { "field.timestamp": { "name": "createdAt" } },
        { "field.enum":   { "name": "statuses", "isArray": true, "@values": ["DRAFT", "LIVE"] } },
        { "field.object": { "name": "home", "@objectRef": "Address", "@storage": "flattened" } },
        { "field.object": { "name": "config", "@objectRef": "Address", "@storage": "jsonb" } },
        { "field.map":    { "name": "labels", "@valueType": "string" } },
        { "field.long":   { "name": "parentId" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "refParent", "@fields": "parentId", "@references": "Auth" } }
      ]}},
      { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
        { "field.int":  { "name": "quantity", "@required": true, "@default": 3 } },
        { "field.enum": { "name": "tiers", "isArray": true, "@values": ["A", "B"] } },
        { "field.object": { "name": "site", "@objectRef": "Address", "@storage": "flattened" } }
      ]}}
    ]}}
    """;

    // Two plain entities and nothing that needs fluent configuration: no OnModelCreating by default.
    private const string PlainModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "label", "@maxLength": 40 } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load(string model = Model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "hooks.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    private static string Db(DbContextGenerator g, MetaRoot root) =>
        Assert.Single(g.Generate(Ctx(root))).Content;

    private static IReadOnlyList<EmittedFile> Entities(EntityGenerator g, MetaRoot root) =>
        g.Generate(Ctx(root)).ToList();

    private static string[] Lines(string s) => s.Replace("\r\n", "\n").Split('\n');

    // The lines of `after` that are not in `before`, and vice versa (multiset difference).
    private static (List<string> Removed, List<string> Added) Diff(string before, string after)
    {
        var b = Lines(before).ToList();
        var a = Lines(after).ToList();
        var removed = new List<string>();
        foreach (var l in b)
        {
            if (!a.Remove(l)) removed.Add(l);
        }
        return (removed, a);
    }

    // ------------------------------------------------------------ recorders

    private sealed class RecordingDb : DbContextGenerator
    {
        public readonly List<string> Calls = [];

        protected override string ContextBaseClass(GenContext ctx) { Calls.Add("ContextBaseClass"); return base.ContextBaseClass(ctx); }
        protected override IEnumerable<string> ContextPreambleLines(GenContext ctx) { Calls.Add("ContextPreambleLines"); return base.ContextPreambleLines(ctx); }
        protected override IEnumerable<string> ContextTrailerLines(GenContext ctx) { Calls.Add("ContextTrailerLines"); return base.ContextTrailerLines(ctx); }
        protected override bool AlwaysEmitOnModelCreating(GenContext ctx) { Calls.Add("AlwaysEmitOnModelCreating"); return base.AlwaysEmitOnModelCreating(ctx); }
        protected override string DbSetLine(MetaObject entity, GenContext ctx) { Calls.Add($"DbSetLine:{entity.Name}"); return base.DbSetLine(entity, ctx); }
        protected override string? DbColumnTypeConfig(string owner, MetaField f) { Calls.Add($"DbColumnTypeConfig:{owner}.{f.Name}"); return base.DbColumnTypeConfig(owner, f); }
        protected override IEnumerable<string> ReferenceConfig(MetaObject entity, MetaReferenceIdentity reference, GenContext ctx) { Calls.Add($"ReferenceConfig:{entity.Name}.{reference.Name}"); return base.ReferenceConfig(entity, reference, ctx); }
        protected override IEnumerable<string> DefaultValueConfig(MetaObject entity, MetaField f, GenContext ctx) { Calls.Add($"DefaultValueConfig:{entity.Name}.{f.Name}"); return base.DefaultValueConfig(entity, f, ctx); }
        protected override string? EnumConversionCall(string owner, MetaObject entity, MetaField f, GenContext ctx) { Calls.Add($"EnumConversionCall:{entity.Name}.{f.Name}"); return base.EnumConversionCall(owner, entity, f, ctx); }
        protected override IEnumerable<string> FieldTypeConfig(string owner, MetaObject entity, MetaField f, GenContext ctx) { Calls.Add($"FieldTypeConfig:{entity.Name}.{f.Name}"); return base.FieldTypeConfig(owner, entity, f, ctx); }
        protected override string? OwnedTypeConfig(string owner, MetaObject entity, MetaField field, GenContext ctx) { Calls.Add($"OwnedTypeConfig:{entity.Name}.{field.Name}"); return base.OwnedTypeConfig(owner, entity, field, ctx); }
        protected override IEnumerable<string> TphSubtypeFieldConfig(MetaObject root, MetaObject subtype, GenContext ctx) { Calls.Add($"TphSubtypeFieldConfig:{root.Name}>{subtype.Name}"); return base.TphSubtypeFieldConfig(root, subtype, ctx); }
        protected override IEnumerable<string> EntityConfigTrailer(MetaObject entity, GenContext ctx) { Calls.Add($"EntityConfigTrailer:{entity.Name}"); return base.EntityConfigTrailer(entity, ctx); }
    }

    private sealed class RecordingEntity : EntityGenerator
    {
        public readonly List<string> Calls = [];

        protected override string PropertyClrType(MetaObject owner, MetaField field, GenContext ctx) { Calls.Add($"PropertyClrType:{owner.Name}.{field.Name}"); return base.PropertyClrType(owner, field, ctx); }
        protected override string? PropertyInitializer(MetaObject owner, MetaField field, GenContext ctx) { Calls.Add($"PropertyInitializer:{owner.Name}.{field.Name}"); return base.PropertyInitializer(owner, field, ctx); }
        protected override EmittedFile? EmitValueObjectPoco(MetaObject vo, GenContext ctx) { Calls.Add($"EmitValueObjectPoco:{vo.Name}"); return base.EmitValueObjectPoco(vo, ctx); }
    }

    // ------------------------------------------------------------ default output

    [Fact]
    public void Default_output_is_unchanged()
    {
        var root = Load();
        Assert.Equal(Db(new DbContextGenerator(), root), Db(new RecordingDb(), root));

        var stock = Entities(new EntityGenerator(), root);
        var hooked = Entities(new RecordingEntity(), root);
        Assert.Equal(stock.Select(f => f.Path), hooked.Select(f => f.Path));
        Assert.Equal(stock.Select(f => f.Content), hooked.Select(f => f.Content));
    }

    // ------------------------------------------------------------ is_called_for_every

    [Fact]
    public void ContextBaseClass_is_called_for_every_context()
    {
        var g = new RecordingDb();
        Db(g, Load());
        Assert.Single(g.Calls, c => c == "ContextBaseClass");
    }

    [Fact]
    public void ContextPreambleLines_is_called_for_every_OnModelCreating()
    {
        var g = new RecordingDb();
        Db(g, Load());
        Assert.Single(g.Calls, c => c == "ContextPreambleLines");
    }

    [Fact]
    public void ContextTrailerLines_is_called_for_every_OnModelCreating()
    {
        var g = new RecordingDb();
        Db(g, Load());
        Assert.Single(g.Calls, c => c == "ContextTrailerLines");
    }

    [Fact]
    public void AlwaysEmitOnModelCreating_is_called_for_every_context()
    {
        var g = new RecordingDb();
        Db(g, Load(PlainModel));
        Assert.Contains("AlwaysEmitOnModelCreating", g.Calls);
    }

    [Fact]
    public void DbSetLine_is_called_for_every_persisted_entity()
    {
        var g = new RecordingDb();
        Db(g, Load());
        // The TPH subtype shares the base's DbSet, so only the root asks.
        Assert.Equal(["DbSetLine:Auth"], g.Calls.Where(c => c.StartsWith("DbSetLine:")));
    }

    [Fact]
    public void DbColumnTypeConfig_is_called_for_every_dbColumnType_field()
    {
        var g = new RecordingDb();
        Db(g, Load());
        Assert.Equal(["DbColumnTypeConfig:Auth.uid"], g.Calls.Where(c => c.StartsWith("DbColumnTypeConfig:")));
    }

    [Fact]
    public void ReferenceConfig_is_called_for_every_enforced_reference_including_a_self_reference()
    {
        var g = new RecordingDb();
        Db(g, Load());
        Assert.Equal(["ReferenceConfig:Auth.refParent"], g.Calls.Where(c => c.StartsWith("ReferenceConfig:")));
    }

    [Fact]
    public void DefaultValueConfig_is_called_for_every_field_of_every_configured_entity()
    {
        var root = Load();
        var g = new RecordingDb();
        Db(g, root);
        foreach (var f in root.FindObject("Auth")!.Fields())
            Assert.Contains($"DefaultValueConfig:Auth.{f.Name}", g.Calls);
        // A TPH subtype: only the fields it declares itself.
        Assert.Contains("DefaultValueConfig:BridgeAuth.quantity", g.Calls);
        Assert.Contains("DefaultValueConfig:BridgeAuth.tiers", g.Calls);
        Assert.DoesNotContain("DefaultValueConfig:BridgeAuth.reference", g.Calls);
    }

    [Fact]
    public void EnumConversionCall_is_called_for_every_enum_field_including_arrays_and_value_object_members()
    {
        var g = new RecordingDb();
        Db(g, Load());
        foreach (var expected in new[]
                 {
                     "Auth.type", "Auth.statuses", "BridgeAuth.tiers",
                     "Address.kind", // a flattened value object's member
                 })
            Assert.Contains($"EnumConversionCall:{expected}", g.Calls);
    }

    [Fact]
    public void FieldTypeConfig_is_called_for_every_field_of_every_configured_entity()
    {
        var root = Load();
        var g = new RecordingDb();
        Db(g, root);
        foreach (var f in root.FindObject("Auth")!.Fields())
            Assert.Contains($"FieldTypeConfig:Auth.{f.Name}", g.Calls);
        // The subtype's OWN fields, configured on its own builder.
        Assert.Contains("FieldTypeConfig:BridgeAuth.quantity", g.Calls);
        Assert.Contains("FieldTypeConfig:BridgeAuth.tiers", g.Calls);
        Assert.Contains("FieldTypeConfig:BridgeAuth.site", g.Calls);
    }

    [Fact]
    public void OwnedTypeConfig_is_called_for_every_object_field_flattened_or_jsonb()
    {
        var g = new RecordingDb();
        Db(g, Load());
        Assert.Equal(
            ["OwnedTypeConfig:Auth.home", "OwnedTypeConfig:Auth.config", "OwnedTypeConfig:BridgeAuth.site"],
            g.Calls.Where(c => c.StartsWith("OwnedTypeConfig:")));
    }

    [Fact]
    public void TphSubtypeFieldConfig_is_called_for_every_subtype_of_every_root()
    {
        var g = new RecordingDb();
        Db(g, Load());
        Assert.Equal(["TphSubtypeFieldConfig:Auth>BridgeAuth"], g.Calls.Where(c => c.StartsWith("TphSubtypeFieldConfig:")));
    }

    [Fact]
    public void EntityConfigTrailer_is_called_for_every_configured_entity()
    {
        var g = new RecordingDb();
        Db(g, Load());
        Assert.Equal(["EntityConfigTrailer:Auth"], g.Calls.Where(c => c.StartsWith("EntityConfigTrailer:")));
    }

    [Fact]
    public void PropertyClrType_is_called_for_every_emitted_property()
    {
        var root = Load();
        var g = new RecordingEntity();
        Entities(g, root);
        foreach (var f in root.FindObject("Auth")!.Fields())
            Assert.Contains($"PropertyClrType:Auth.{f.Name}", g.Calls);
        foreach (var n in new[] { "quantity", "tiers", "site" })
            Assert.Contains($"PropertyClrType:BridgeAuth.{n}", g.Calls);
        foreach (var n in new[] { "street", "kind" })
            Assert.Contains($"PropertyClrType:Address.{n}", g.Calls);
    }

    [Fact]
    public void PropertyInitializer_is_called_for_every_emitted_property()
    {
        var root = Load();
        var g = new RecordingEntity();
        Entities(g, root);
        foreach (var f in root.FindObject("Auth")!.Fields())
            Assert.Contains($"PropertyInitializer:Auth.{f.Name}", g.Calls);
        Assert.Contains("PropertyInitializer:BridgeAuth.quantity", g.Calls);
        Assert.Contains("PropertyInitializer:Address.street", g.Calls);
    }

    [Fact]
    public void EmitValueObjectPoco_is_called_for_every_anchored_value_object()
    {
        var g = new RecordingEntity();
        Entities(g, Load());
        Assert.Equal(["EmitValueObjectPoco:Address"], g.Calls.Where(c => c.StartsWith("EmitValueObjectPoco:")));
    }

    // ------------------------------------------------------------ Override_..._changes_only_its_lines

    private sealed class BaseClassDb : DbContextGenerator
    {
        protected override string ContextBaseClass(GenContext ctx) => "AdopterDbContext";
    }

    [Fact]
    public void Override_of_ContextBaseClass_changes_only_its_lines()
    {
        var root = Load();
        var (removed, added) = Diff(Db(new DbContextGenerator(), root), Db(new BaseClassDb(), root));
        Assert.Equal(["public class AppDbContext : DbContext"], removed);
        Assert.Equal(["public class AppDbContext : AdopterDbContext"], added);
    }

    private sealed class PreambleTrailerDb : DbContextGenerator
    {
        protected override IEnumerable<string> ContextPreambleLines(GenContext ctx) =>
            base.ContextPreambleLines(ctx).Append("        base.OnModelCreating(modelBuilder);");
        protected override IEnumerable<string> ContextTrailerLines(GenContext ctx) =>
            base.ContextTrailerLines(ctx).Append("        OnModelCreatingExtensions(modelBuilder);");
    }

    [Fact]
    public void Override_of_ContextPreambleLines_changes_only_its_lines()
    {
        var root = Load();
        var stock = Db(new DbContextGenerator(), root);
        var src = Db(new PreambleTrailerDb(), root);
        var (removed, added) = Diff(stock, src);
        Assert.Empty(removed);
        Assert.Equal(
            ["        base.OnModelCreating(modelBuilder);", "        OnModelCreatingExtensions(modelBuilder);"],
            added);
        var body = Lines(src);
        var open = Array.IndexOf(body, "    protected override void OnModelCreating(ModelBuilder modelBuilder)");
        Assert.Equal("        base.OnModelCreating(modelBuilder);", body[open + 2]);
    }

    [Fact]
    public void Override_of_ContextTrailerLines_changes_only_its_lines()
    {
        var root = Load();
        var src = Db(new PreambleTrailerDb(), root);
        var body = Lines(src);
        var trailer = Array.IndexOf(body, "        OnModelCreatingExtensions(modelBuilder);");
        // The trailer is the last statement of OnModelCreating: the next line closes the method.
        Assert.Equal("    }", body[trailer + 1]);
    }

    private sealed class AlwaysDb : DbContextGenerator
    {
        protected override bool AlwaysEmitOnModelCreating(GenContext ctx) => true;
    }

    [Fact]
    public void Override_of_AlwaysEmitOnModelCreating_changes_only_its_lines()
    {
        var root = Load(PlainModel);
        var stock = Db(new DbContextGenerator(), root);
        Assert.DoesNotContain("OnModelCreating", stock);
        var (removed, added) = Diff(stock, Db(new AlwaysDb(), root));
        Assert.Empty(removed);
        Assert.Equal(
            new[] { "", "    protected override void OnModelCreating(ModelBuilder modelBuilder)", "    {", "    }" }.Order(),
            added.Order());
    }

    private sealed class DbSetDb : DbContextGenerator
    {
        protected override string DbSetLine(MetaObject entity, GenContext ctx) =>
            base.DbSetLine(entity, ctx).Replace("public DbSet", "public virtual DbSet");
    }

    [Fact]
    public void Override_of_DbSetLine_changes_only_its_lines()
    {
        var root = Load();
        var (removed, added) = Diff(Db(new DbContextGenerator(), root), Db(new DbSetDb(), root));
        Assert.Equal(["    public DbSet<Auth> Auths { get; set; } = default!;"], removed);
        Assert.Equal(["    public virtual DbSet<Auth> Auths { get; set; } = default!;"], added);
    }

    private sealed class DbColumnTypeDb : DbContextGenerator
    {
        protected override string? DbColumnTypeConfig(string owner, MetaField f) => null;
    }

    [Fact]
    public void Override_of_DbColumnTypeConfig_changes_only_its_lines()
    {
        var root = Load();
        var (removed, added) = Diff(Db(new DbContextGenerator(), root), Db(new DbColumnTypeDb(), root));
        Assert.Empty(added);
        var line = Assert.Single(removed);
        Assert.Contains(".Property(x => x.Uid).HasColumnType(\"uuid\")", line);
    }

    private sealed class NoReferenceDb : DbContextGenerator
    {
        protected override IEnumerable<string> ReferenceConfig(MetaObject entity, MetaReferenceIdentity reference, GenContext ctx) => [];
    }

    [Fact]
    public void Override_of_ReferenceConfig_changes_only_its_lines()
    {
        var root = Load();
        var (removed, added) = Diff(Db(new DbContextGenerator(), root), Db(new NoReferenceDb(), root));
        Assert.Empty(added);
        var line = Assert.Single(removed);
        Assert.Contains("modelBuilder.Entity<Auth>().HasOne<Auth>().WithMany().HasForeignKey(e => e.ParentId)", line);
    }

    private sealed class DefaultValueDb : DbContextGenerator
    {
        protected override IEnumerable<string> DefaultValueConfig(MetaObject entity, MetaField f, GenContext ctx) =>
            base.DefaultValueConfig(entity, f, ctx).Select(l => l + " // adopter");
    }

    [Fact]
    public void Override_of_DefaultValueConfig_changes_only_its_lines()
    {
        var root = Load();
        var (removed, added) = Diff(Db(new DbContextGenerator(), root), Db(new DefaultValueDb(), root));
        // `active` on the root and `quantity` on the subtype.
        Assert.Equal(2, removed.Count);
        Assert.Equal(removed.Select(l => l + " // adopter"), added);
        Assert.All(removed, l => Assert.Contains("HasDefaultValue(", l));
    }

    private sealed class EnumDb : DbContextGenerator
    {
        protected override string? EnumConversionCall(string owner, MetaObject entity, MetaField f, GenContext ctx) =>
            base.EnumConversionCall(owner, entity, f, ctx) + "/*adopter*/";
    }

    [Fact]
    public void Override_of_EnumConversionCall_changes_only_its_lines()
    {
        var root = Load();
        var (removed, added) = Diff(Db(new DbContextGenerator(), root), Db(new EnumDb(), root));
        Assert.NotEmpty(removed);
        Assert.Equal(removed.Count, added.Count);
        Assert.All(added, l => Assert.Contains("/*adopter*/", l));
        Assert.All(removed, l => Assert.Contains("HasConversion", l));
    }

    private sealed class FieldTypeDb : DbContextGenerator
    {
        protected override IEnumerable<string> FieldTypeConfig(string owner, MetaObject entity, MetaField f, GenContext ctx) =>
            base.FieldTypeConfig(owner, entity, f, ctx).Concat(
                f.Name == "note" ? [$"        // adopter line for {owner}.{f.Name}"] : []);
    }

    [Fact]
    public void Override_of_FieldTypeConfig_changes_only_its_lines()
    {
        var root = Load();
        var (removed, added) = Diff(Db(new DbContextGenerator(), root), Db(new FieldTypeDb(), root));
        Assert.Empty(removed);
        Assert.Equal(["        // adopter line for Auth.note"], added);
    }

    private sealed class OwnedDb : DbContextGenerator
    {
        protected override string? OwnedTypeConfig(string owner, MetaObject entity, MetaField field, GenContext ctx) =>
            field.Name == "config" ? null : base.OwnedTypeConfig(owner, entity, field, ctx);
    }

    [Fact]
    public void Override_of_OwnedTypeConfig_changes_only_its_lines()
    {
        var root = Load();
        var (removed, added) = Diff(Db(new DbContextGenerator(), root), Db(new OwnedDb(), root));
        Assert.Empty(added);
        // The jsonb value object's block (it holds an enum, so it is the multi-line form) is
        // gone; the flattened ones are not.
        Assert.Contains(removed, l => l.Contains("modelBuilder.Entity<Auth>().OwnsOne(x => x.Config"));
        Assert.DoesNotContain(removed, l => l.Contains("OwnsOne(x => x.Home"));
        Assert.DoesNotContain(removed, l => l.Contains("OwnsOne(x => x.Site"));
    }

    private sealed class TphDb : DbContextGenerator
    {
        protected override IEnumerable<string> TphSubtypeFieldConfig(MetaObject root, MetaObject subtype, GenContext ctx) =>
            [$"        // adopter {root.Name}>{subtype.Name}"];
    }

    [Fact]
    public void Override_of_TphSubtypeFieldConfig_changes_only_its_lines()
    {
        var root = Load();
        var stock = Db(new DbContextGenerator(), root);
        var (removed, added) = Diff(stock, Db(new TphDb(), root));
        Assert.Equal(["        // adopter Auth>BridgeAuth"], added);
        // Everything removed is configuration of the subtype's own builder, nothing of the root's.
        Assert.NotEmpty(removed);
        Assert.Contains(removed, l => l.Contains("modelBuilder.Entity<BridgeAuth>()"));
        Assert.DoesNotContain(removed, l => l.Contains("Entity<Auth>()"));
    }

    private sealed class TrailerDb : DbContextGenerator
    {
        protected override IEnumerable<string> EntityConfigTrailer(MetaObject entity, GenContext ctx) =>
            [$"        modelBuilder.Entity<{entity.Name}>().HasIndex(x => x.Id);"];
    }

    [Fact]
    public void Override_of_EntityConfigTrailer_changes_only_its_lines()
    {
        var root = Load();
        var (removed, added) = Diff(Db(new DbContextGenerator(), root), Db(new TrailerDb(), root));
        Assert.Empty(removed);
        Assert.Equal(["        modelBuilder.Entity<Auth>().HasIndex(x => x.Id);"], added);
    }

    private sealed class PropTypeEntity : EntityGenerator
    {
        protected override string PropertyClrType(MetaObject owner, MetaField field, GenContext ctx) =>
            field.Name == "note" ? "global::System.Text.StringBuilder?" : base.PropertyClrType(owner, field, ctx);
    }

    [Fact]
    public void Override_of_PropertyClrType_changes_only_its_lines()
    {
        var root = Load();
        var stock = Entities(new EntityGenerator(), root);
        var hooked = Entities(new PropTypeEntity(), root);
        var s = stock.Single(f => f.Path == "Auth.g.cs").Content;
        var h = hooked.Single(f => f.Path == "Auth.g.cs").Content;
        var (removed, added) = Diff(s, h);
        Assert.Equal(["    public string? Note { get; set; }"], removed);
        Assert.Equal(["    public global::System.Text.StringBuilder? Note { get; set; }"], added);
        foreach (var f in stock.Where(f => f.Path != "Auth.g.cs"))
            Assert.Equal(f.Content, hooked.Single(x => x.Path == f.Path).Content);
    }

    private sealed class PropInitEntity : EntityGenerator
    {
        protected override string? PropertyInitializer(MetaObject owner, MetaField field, GenContext ctx) =>
            field.Name == "note" ? "\"n/a\"" : base.PropertyInitializer(owner, field, ctx);
    }

    [Fact]
    public void Override_of_PropertyInitializer_changes_only_its_lines()
    {
        var root = Load();
        var s = Entities(new EntityGenerator(), root).Single(f => f.Path == "Auth.g.cs").Content;
        var h = Entities(new PropInitEntity(), root).Single(f => f.Path == "Auth.g.cs").Content;
        var (removed, added) = Diff(s, h);
        Assert.Equal(["    public string? Note { get; set; }"], removed);
        Assert.Equal(["    public string? Note { get; set; } = \"n/a\";"], added);
    }

    private sealed class DropAddressEntity : EntityGenerator
    {
        protected override EmittedFile? EmitValueObjectPoco(MetaObject vo, GenContext ctx) =>
            vo.Name == "Address" ? null : base.EmitValueObjectPoco(vo, ctx);
    }

    [Fact]
    public void Override_of_EmitValueObjectPoco_changes_only_its_lines()
    {
        var root = Load();
        var stock = Entities(new EntityGenerator(), root);
        var hooked = Entities(new DropAddressEntity(), root);
        Assert.Contains(stock, f => f.Path == "Address.g.cs");
        Assert.DoesNotContain(hooked, f => f.Path == "Address.g.cs");
        Assert.Equal(
            stock.Where(f => f.Path != "Address.g.cs").Select(f => (f.Path, f.Content)),
            hooked.Select(f => (f.Path, f.Content)));
    }

    // ------------------------------------------------------------ ordering over the chunk split

    [Fact]
    public void Preamble_chunks_trailer_order_over_200_lines()
    {
        var sb = new StringBuilder("""{ "metadata.root": { "package": "acme", "children": [""");
        for (var i = 0; i < 70; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append($$$"""
            { "object.entity": { "name": "E{{{i:D2}}}", "children": [
              { "source.rdb": { "@table": "e{{{i:D2}}}" } },
              { "field.long": { "name": "id" } },
              { "field.enum": { "name": "status", "@values": ["A", "B"] } },
              { "field.decimal": { "name": "amt", "@precision": 10, "@scale": 2 } },
              { "field.timestamp": { "name": "at" } },
              { "identity.primary": { "@fields": "id" } }
            ]}}
            """);
        }
        sb.Append("]}}");
        var root = Load(sb.ToString());

        var src = Db(new PreambleTrailerDb(), root);
        var lines = Lines(src);
        var open = Array.IndexOf(lines, "    protected override void OnModelCreating(ModelBuilder modelBuilder)");
        Assert.True(open >= 0);
        var close = Array.IndexOf(lines, "    }", open);

        // The body is: preamble, ConfigureModelNN calls in order, trailer.
        Assert.Equal("    {", lines[open + 1]);
        Assert.Equal("        base.OnModelCreating(modelBuilder);", lines[open + 2]);
        Assert.Equal("        OnModelCreatingExtensions(modelBuilder);", lines[close - 1]);
        var calls = lines[(open + 3)..(close - 1)];
        Assert.True(calls.Length >= 2, "a model over 200 lines is split into at least two methods");
        for (var i = 0; i < calls.Length; i++)
            Assert.Equal($"        ConfigureModel{i + 1:D2}(modelBuilder);", calls[i]);
        // And the chunk methods themselves follow the method, in order.
        var defs = lines.Where(l => l.StartsWith("    private void ConfigureModel")).ToList();
        Assert.Equal(calls.Length, defs.Count);
        for (var i = 0; i < defs.Count; i++)
            Assert.Equal($"    private void ConfigureModel{i + 1:D2}(ModelBuilder modelBuilder)", defs[i]);
    }
}
