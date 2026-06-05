// Turns a payload value-object into C# source fragments for the FR-010 extract codegen:
//   • SchemaLiteral      — a `new ExtractSchema(Format.X, "root", new FieldSpec[] { … })`
//                          baked descriptor for the emitted parser class.
//   • MirrorRecordDecl   — an all-nullable mirror record `<Payload>Extracted` (C# `required`
//                          init props can't take null for a lost-required field, so extract
//                          returns this nullable twin rather than the strict payload — same
//                          reasoning as the Kotlin port's nullable mirror).
//   • MirrorInitializer  — `new <Payload>Extracted { prop = ExtractMap.As*(d, "prop"), … }`.
//
// Mirrors the Java ExtractSchemaEmitter (adapted to C# syntax + the nullable-mirror shape).
// Bounded scope: scalar / enum / scalar-array. Nested object + array-of-enum deferred.

using System.Linq;
using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

internal static class ExtractSchemaEmitter
{
    /// <summary>Emit <c>new ExtractSchema(Format.X, "rootName", new FieldSpec[] { … })</c>.</summary>
    public static string SchemaLiteral(MetaData vo, string format, string rootName)
    {
        string formatEnum = format.Equals("xml", System.StringComparison.OrdinalIgnoreCase)
            ? "Format.Xml" : "Format.Json";
        var specs = Fr010FieldMapping.Fields(vo).Select(f => FieldSpecLiteral(f, vo));
        return $"new ExtractSchema({formatEnum}, \"{rootName}\", new FieldSpec[] {{ {string.Join(", ", specs)} }})";
    }

    private static string FieldSpecLiteral(MetaData field, MetaData owner)
    {
        string name = field.Name;
        bool required = Fr010FieldMapping.IsRequired(field);

        if (field.SubType == FIELD_SUBTYPE_ENUM)
            return EnumFieldSpec(name, required, field, owner);

        if (field.SubType == FIELD_SUBTYPE_OBJECT)
            return $"FieldSpec.Scalar(\"{name}\", FieldKind.String, {Bool(required)}) /* FR-010: nested extract deferred */";

        string kind = Fr010FieldMapping.ScalarKind(field.SubType) ?? "String";
        // @xmlText: a (non-array) scalar field marked to receive its element's XML text content.
        if (!Fr010FieldMapping.IsArray(field) && Fr010FieldMapping.HasXmlText(field))
            return $"FieldSpec.TextContentField(\"{name}\", FieldKind.{kind}, {Bool(required)})";
        return $"FieldSpec.Scalar(\"{name}\", FieldKind.{kind}, {Bool(required)})";
    }

    private static string EnumFieldSpec(string name, bool required, MetaData field, MetaData owner)
    {
        string valuesLit = Fr010FieldMapping.StringArrayLiteral(Fr010FieldMapping.EnumValues(field));
        string aliasLit = Fr010FieldMapping.PropertiesMapLiteral(field.OwnAttr(FIELD_ATTR_ENUM_ALIAS));

        // FR-011: resolve the three new enum args (field → object.value → "strip" for normalize).
        // Keep the back-compat 4-arg form when nothing is set; otherwise emit the positional tail
        // up to the last meaningful argument. EnumField signature is
        //   (name, required, values, aliases, coerceDefault?, normalize=Strip, defaultValue?).
        string? cd = Fr010FieldMapping.CoerceDefault(field);
        string? dv = Fr010FieldMapping.DefaultValue(field);
        string normalize = Fr010FieldMapping.ResolveNormalize(field, owner);

        if (cd == null && dv == null && normalize == NORMALIZE_DEFAULT)
            return $"FieldSpec.EnumField(\"{name}\", {Bool(required)}, {valuesLit}, {aliasLit})";

        string cdLit = cd == null ? "null" : $"\"{Fr010FieldMapping.CSharpStringLiteral(cd)}\"";
        string normLit = Fr010FieldMapping.NormalizeModeMember(normalize);

        if (dv == null)
            return $"FieldSpec.EnumField(\"{name}\", {Bool(required)}, {valuesLit}, {aliasLit}, {cdLit}, {normLit})";

        string dvLit = $"\"{Fr010FieldMapping.CSharpStringLiteral(dv)}\"";
        return $"FieldSpec.EnumField(\"{name}\", {Bool(required)}, {valuesLit}, {aliasLit}, {cdLit}, {normLit}, {dvLit})";
    }

    /// <summary>Emit the all-nullable mirror record declaration.</summary>
    public static string MirrorRecordDecl(MetaData vo, string recordName)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"/// <summary>Best-effort extracted twin of <c>{RecordBase(recordName)}</c> — every component nullable (null where lost/malformed).</summary>");
        sb.AppendLine($"public sealed record {recordName}");
        sb.AppendLine("{");
        foreach (var f in Fr010FieldMapping.Fields(vo))
            sb.AppendLine($"    public {Fr010FieldMapping.MirrorType(f)} {f.Name} {{ get; init; }}");
        sb.AppendLine("}");
        return sb.ToString();
    }

    /// <summary>Emit <c>new &lt;recordName&gt; { prop = ExtractMap.As*(d, "prop"), … }</c>.</summary>
    public static string MirrorInitializer(MetaData vo, string recordName)
    {
        var assigns = Fr010FieldMapping.Fields(vo).Select(f => $"{f.Name} = {Fr010FieldMapping.ExtractMapCall(f)}");
        return $"new {recordName} {{ {string.Join(", ", assigns)} }}";
    }

    // ---- helpers ----

    private static string RecordBase(string recordName) =>
        recordName.EndsWith("Extracted", System.StringComparison.Ordinal)
            ? recordName[..^"Extracted".Length] : recordName;

    private static string Bool(bool b) => b ? "true" : "false";
}
