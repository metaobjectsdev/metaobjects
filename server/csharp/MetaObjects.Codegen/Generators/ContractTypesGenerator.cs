// contract-types-generator — ADR-0067 layer 1 for writes: one <Entity>Contracts.g.cs per writable
// entity, holding a create record and an update record, each a `sealed record` with the same
// validation DataAnnotations and wire converters the entity carries (ContractMembers, the one copy
// both generators write from).
//
//   <Entity>Create  the members a client sends to create a row. A required member with no @default
//                   is a C# `required` member, so System.Text.Json refuses a body that omits it.
//   <Entity>Update  the members a client may change. Every member is optional. `From` binds a body
//                   and records which keys it carried, so an omitted member and an explicit null
//                   stay apart (the PATCH contract: omitted is untouched, null clears, and null on
//                   a required member is refused, which `Validate` reports).
//
// Neither carries what the server owns: a derived (origin.*) field, an @autoSet stamp, a readOnly
// field, a TPH discriminator. A generated key (@generation increment or uuid) is left off the
// create record; every key is left off the update record, because the route names the row. A
// writeOnce field is frozen after create, so it is on the create record and not on the update record.
// A lifecycle field is on both: the service shell checks a create against the initial state and
// refuses a change on the generic update with 409 state_managed (ADR-0066 §6), and to refuse it the
// shell has to see it.
//
// A layer generator, separate from the flat ones (ADR-0067 §5.2). The records name the entity's
// enum and value-object types and its wire helpers, so `entity` runs in the same project.

using MetaObjects.Codegen.Docs;
using MetaObjects.Codegen.Writer;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Identity.IdentityConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>Generates the create and update records of each writable entity.</summary>
public class ContractTypesGenerator : PerEntityGenerator
{
    public override string Name => "contract-types";

    /// <summary>A concrete entity the generated routes write: a writable primary source and instance artifacts.</summary>
    public override bool Filter(MetaObject entity) =>
        entity.IsEntity() && !entity.IsAbstract && !entity.IsReadOnlyProjection()
        && entity.FindPrimaryWritableSource() is not null && InstanceArtifacts.EmitsInstanceArtifacts(entity);

    /// <summary>Which record a member is written for.</summary>
    protected enum Shape { Create, Update }

    protected override EmittedFile GenerateOne(MetaObject entity, GenContext ctx)
    {
        var cls = CSharpNaming.Pascal(entity.Name);
        var ns = PackageBindingResolver.Resolve(ctx.Config, PackageBindingResolver.EffectivePackage(entity), entity.Name, fallbackContext: entity.Name);
        var create = CreateFields(entity, ctx);
        var update = UpdateFields(entity, ctx);
        foreach (var name in new[] { CreateName(entity), UpdateName(entity) })
            ctx.Claim($"the C# namespace {ns}", name, entity.ResolutionKey(),
                "map the packages to distinct namespaces (csharp.packageNamespaces, or GenConfig.PackageNamespaces), or rename one");

        var w = NewWriter();
        WriteFileHeader(w, entity, ctx);
        w.Blank();
        w.Line($"namespace {ns};");
        w.Blank();
        WriteCreateRecord(w, entity, create, ctx);
        w.Blank();
        WriteUpdateRecord(w, entity, update, ctx);
        return new EmittedFile(OutputPaths.Of(entity, ctx, $"{cls}Contracts.g.cs"), w.ToString());
    }

    /// <summary>The create record's type name.</summary>
    protected virtual string CreateName(MetaObject entity) => CSharpNaming.Pascal(entity.Name) + "Create";

    /// <summary>The update record's type name.</summary>
    protected virtual string UpdateName(MetaObject entity) => CSharpNaming.Pascal(entity.Name) + "Update";

    // ---- which members ---------------------------------------------------------------------------

    /// <summary>Whether the server owns the field, so neither record carries it.</summary>
    protected virtual bool ServerOwned(MetaObject entity, MetaField field, GenContext ctx) =>
        field.IsDerived() || field.AutoSet is not null || field.IsReadOnlyMutability
        || (TphPlanBuilder.DiscriminatorRoot(entity) is { } root
            && TphPlanBuilder.For(root, ctx.Root)?.DiscriminatorField == field.Name);

    /// <summary>The create record's members, in effective field order.</summary>
    protected virtual IReadOnlyList<MetaField> CreateFields(MetaObject entity, GenContext ctx)
    {
        var generatedKey = entity.PrimaryIdentity() is MetaPrimaryIdentity { Generation: GENERATION_INCREMENT or GENERATION_UUID } pk
            ? pk.Fields.ToHashSet(StringComparer.Ordinal)
            : [];
        return entity.Fields().Where(f => !ServerOwned(entity, f, ctx) && !generatedKey.Contains(f.Name)).ToList();
    }

    /// <summary>The update record's members, in effective field order.</summary>
    protected virtual IReadOnlyList<MetaField> UpdateFields(MetaObject entity, GenContext ctx)
    {
        var key = (entity.PrimaryIdentity()?.Fields ?? []).ToHashSet(StringComparer.Ordinal);
        return entity.Fields().Where(f => !ServerOwned(entity, f, ctx) && !f.IsWriteOnceMutability && !key.Contains(f.Name)).ToList();
    }

    /// <summary>Whether a create body must carry the member: it is required and has no @default to fall back to.</summary>
    protected static bool RequiredOnCreate(MetaObject entity, MetaField field) =>
        CSharpNaming.IsRequired(entity, field) && field.Default is null;

    // ---- the records -----------------------------------------------------------------------------

    /// <summary>The usings: the BCL namespaces the members need and every other package they name.</summary>
    protected virtual void WriteFileHeader(CsWriter w, MetaObject entity, GenContext ctx)
    {
        w.GeneratedFileHeader("contract-types-generator");
        w.Using("System");
        w.Using("System.Collections.Generic");
        w.Using("System.ComponentModel.DataAnnotations");
        w.Using("System.Linq");
        w.Using("System.Text.Json");
        w.Using("System.Text.Json.Serialization");
        if (CSharpNaming.RequiresSystemNet(entity)) w.Using("System.Net");
        foreach (var ns in PackageBindingResolver.CrossPackageReferencedNamespaces(entity, ctx.Root, ctx.Config))
            w.Using(ns);
    }

    /// <summary>The create record.</summary>
    protected virtual void WriteCreateRecord(CsWriter w, MetaObject entity, IReadOnlyList<MetaField> fields, GenContext ctx)
    {
        w.DocSummary($"GENERATED — the body that creates a {CSharpNaming.Pascal(entity.Name)}. Bind it with System.Text.Json; " +
                     "a required member it omits is refused there, and the DataAnnotations hold the rest.");
        using (w.Braced($"public sealed record {CreateName(entity)}"))
        {
            var first = true;
            foreach (var f in fields)
            {
                if (!first) w.Blank();
                first = false;
                WriteMember(w, entity, f, Shape.Create, ctx);
            }
        }
    }

    private static readonly string[] ReservedUpdateMembers = ["Fields", "Present", "Has", "From", "Validate"];

    /// <summary>The update record, with its <c>From</c> binder and the present-null check.</summary>
    protected virtual void WriteUpdateRecord(CsWriter w, MetaObject entity, IReadOnlyList<MetaField> fields, GenContext ctx)
    {
        var name = UpdateName(entity);
        foreach (var f in fields)
            if (ReservedUpdateMembers.Contains(CSharpNaming.PropertyName(f, ctx.Config)))
                throw new InvalidOperationException(
                    $"contract-types: {entity.Name}.{f.Name} becomes the C# member \"{CSharpNaming.PropertyName(f, ctx.Config)}\", " +
                    $"which {name} already declares ({string.Join(", ", ReservedUpdateMembers)}). Rename the field.");
        w.DocSummary($"GENERATED — the body that changes a {CSharpNaming.Pascal(entity.Name)}. Every member is optional: " +
                     "bind it with From, and Has tells an omitted member (untouched) from an explicit null (cleared).");
        using (w.Braced($"public sealed record {name} : IValidatableObject"))
        {
            w.DocSummary("The wire names of the members.");
            w.Line("public static readonly IReadOnlySet<string> Fields = new HashSet<string>(StringComparer.Ordinal)");
            using (w.Braced("", "};"))
            {
                foreach (var f in fields) w.Line($"\"{CSharpNaming.CSharpStringLiteral(f.Name)}\",");
            }
            w.Blank();
            w.DocSummary("The wire names the bound body carried.");
            w.Line("[JsonIgnore]");
            w.Line("public IReadOnlySet<string> Present { get; init; } = new HashSet<string>(StringComparer.Ordinal);");
            w.Blank();
            w.DocSummary("Whether the body carried the member named <paramref name=\"field\"/> (its wire name), null included.");
            w.Line("public bool Has(string field) => Present.Contains(field);");
            w.Blank();
            w.DocSummary("Bind a body with the application's JSON options and record which members it carried.");
            using (w.Braced($"public static {name} From(JsonElement body, JsonSerializerOptions? options = null)"))
            {
                w.Line("if (body.ValueKind != JsonValueKind.Object) throw new JsonException(\"The update body must be a JSON object.\");");
                w.Line($"var bound = body.Deserialize<{name}>(options) ?? new {name}();");
                w.Line("var comparer = options?.PropertyNameCaseInsensitive == true ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;");
                w.Line("var present = new HashSet<string>(StringComparer.Ordinal);");
                using (w.Braced("foreach (var property in body.EnumerateObject())"))
                {
                    w.Line("var match = Fields.FirstOrDefault(f => comparer.Equals(f, property.Name));");
                    w.Line("if (match is not null) present.Add(match);");
                }
                w.Line("return bound with { Present = present };");
            }
            foreach (var f in fields)
            {
                w.Blank();
                WriteMember(w, entity, f, Shape.Update, ctx);
            }
            w.Blank();
            w.DocSummary("A required member the body set to null: it cannot be cleared.");
            using (w.Braced("public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)"))
            {
                var required = fields.Where(f => CSharpNaming.IsRequired(entity, f)).ToList();
                foreach (var f in required)
                {
                    var prop = CSharpNaming.PropertyName(f, ctx.Config);
                    var wire = CSharpNaming.CSharpStringLiteral(f.Name);
                    w.Line($"if (Has(\"{wire}\") && {prop} is null) yield return new ValidationResult(\"{wire} is required and cannot be null.\", [nameof({prop})]);");
                }
                if (required.Count == 0) w.Line("yield break;");
            }
        }
    }

    /// <summary>One member: its doc, wire name, validation and converter attributes, and declaration.</summary>
    protected virtual void WriteMember(CsWriter w, MetaObject entity, MetaField field, Shape shape, GenContext ctx)
    {
        var mustSend = shape == Shape.Create && RequiredOnCreate(entity, field);
        // A required member keeps its non-empty floor in both records: on update it applies when the member is sent.
        var required = CSharpNaming.IsRequired(entity, field);
        var wire = ctx.Root.WireFormat;
        var type = ClrType(entity, field, optional: !mustSend, ctx);

        XmlDocBuilder.WriteTo(w, field);
        w.Line($"[JsonPropertyName(\"{CSharpNaming.CSharpStringLiteral(field.Name)}\")]");
        if (CSharpNaming.ScalarFor(field.SubType) is not null)
        {
            if (field.ResolvedIsArray())
                ContractMembers.WriteArrayValidatorAttributes(w, field);
            else if (ElementType(field) == "string")
            {
                if (mustSend) w.Line("[Required(AllowEmptyStrings = true)]");
                ContractMembers.WriteStringValidatorAttributes(w, field, requiredMinFloor: required ? 1 : 0);
            }
            else
            {
                ContractMembers.WriteNumericValidatorAttributes(w, field);
                if (mustSend && !CSharpNaming.IsValueType(ElementType(field))) w.Line("[Required]");
            }
            ContractMembers.WriteDecimalConverterAttribute(w, field, nullable: !mustSend, wire);
            ContractMembers.WriteDurationConverterAttribute(w, field, wire);
            ContractMembers.WriteNetConverterAttribute(w, field);
        }
        else if (mustSend && field.SubType is FIELD_SUBTYPE_OBJECT or FIELD_SUBTYPE_MAP)
            w.Line("[Required]");

        var prop = CSharpNaming.PropertyName(field, ctx.Config);
        w.Line($"public {(mustSend ? "required " : "")}{type} {prop} {{ get; init; }}");
    }

    /// <summary>A scalar's element type: the override a @dbColumnType implies, else the logical one.</summary>
    protected static string ElementType(MetaField field) =>
        CSharpNaming.DbColumnTypeClrOverride(field) ?? CSharpNaming.ScalarForField(field)!;

    /// <summary>The member's CLR type; <paramref name="optional"/> adds the <c>?</c>.</summary>
    protected virtual string ClrType(MetaObject entity, MetaField field, bool optional, GenContext ctx)
    {
        var q = optional ? "?" : "";
        string element;
        if (CSharpNaming.ScalarFor(field.SubType) is not null)
            element = ElementType(field);
        else if (field.SubType == FIELD_SUBTYPE_ENUM)
        {
            element = ContractMembers.EnumPropertyTypeName(entity, field, ctx.Config);
            // An inline enum is nested in the entity's class; a shared one is already qualified.
            if (Fr019SharedEnum.SharedEnumForField(field) is null) element = $"{CSharpNaming.Pascal(entity.Name)}.{element}";
        }
        else if (field.SubType == FIELD_SUBTYPE_OBJECT)
            element = ValueObjectNames.ResolveFieldRef(field, ctx.Root) is { } target
                ? ValueObjectNames.ShortRef(target, ctx.Root, ctx.Config, ValueObjectNames.Namespace(entity, ctx.Config))
                : CSharpNaming.Pascal(CSharpNaming.StripPkg(field.ObjectRef ?? field.Name));
        else if (field.SubType == FIELD_SUBTYPE_MAP)
            return $"Dictionary<string, {ContractMembers.MapValueTypeRef(field, entity, ctx)}>{q}";
        else
            element = CSharpNaming.ScalarForField(field) ?? "object";
        return field.ResolvedIsArray() ? $"IList<{element}>{q}" : element + q;
    }

    /// <summary>The writer the file is written on.</summary>
    protected virtual CsWriter NewWriter() => new();
}
