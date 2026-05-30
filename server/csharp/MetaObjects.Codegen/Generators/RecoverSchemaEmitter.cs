// Turns a payload value-object into C# source fragments for the FR-010 recover codegen:
//   • SchemaLiteral      — a `new RecoverSchema(Format.X, "root", new FieldSpec[] { … })`
//                          baked descriptor for the emitted parser class.
//   • MirrorRecordDecl   — an all-nullable mirror record `<Payload>Recovered` (C# `required`
//                          init props can't take null for a lost-required field, so recover
//                          returns this nullable twin rather than the strict payload — same
//                          reasoning as the Kotlin port's nullable mirror).
//   • MirrorInitializer  — `new <Payload>Recovered { prop = RecoverMap.As*(d, "prop"), … }`.
//
// Mirrors the Java RecoverSchemaEmitter (adapted to C# syntax + the nullable-mirror shape).
// Bounded scope: scalar / enum / scalar-array. Nested object + array-of-enum deferred.

using System.Linq;
using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

internal static class RecoverSchemaEmitter
{
    /// <summary>Emit <c>new RecoverSchema(Format.X, "rootName", new FieldSpec[] { … })</c>.</summary>
    public static string SchemaLiteral(MetaData vo, string format, string rootName)
    {
        string formatEnum = format.Equals("xml", System.StringComparison.OrdinalIgnoreCase)
            ? "Format.Xml" : "Format.Json";
        var specs = Fr010FieldMapping.Fields(vo).Select(FieldSpecLiteral);
        return $"new RecoverSchema({formatEnum}, \"{rootName}\", new FieldSpec[] {{ {string.Join(", ", specs)} }})";
    }

    private static string FieldSpecLiteral(MetaData field)
    {
        string name = field.Name;
        bool required = Fr010FieldMapping.IsRequired(field);

        if (field.SubType == FIELD_SUBTYPE_ENUM)
            return EnumFieldSpec(name, required, field);

        if (field.SubType == FIELD_SUBTYPE_OBJECT)
            return $"FieldSpec.Scalar(\"{name}\", FieldKind.String, {Bool(required)}) /* FR-010: nested recover deferred */";

        string kind = Fr010FieldMapping.ScalarKind(field.SubType) ?? "String";
        return $"FieldSpec.Scalar(\"{name}\", FieldKind.{kind}, {Bool(required)})";
    }

    private static string EnumFieldSpec(string name, bool required, MetaData field)
    {
        string valuesLit = Fr010FieldMapping.StringArrayLiteral(Fr010FieldMapping.EnumValues(field));
        string aliasLit = Fr010FieldMapping.PropertiesMapLiteral(field.OwnAttr(FIELD_ATTR_ENUM_ALIAS));
        return $"FieldSpec.EnumField(\"{name}\", {Bool(required)}, {valuesLit}, {aliasLit})";
    }

    /// <summary>Emit the all-nullable mirror record declaration.</summary>
    public static string MirrorRecordDecl(MetaData vo, string recordName)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"/// <summary>Best-effort recovered twin of <c>{RecordBase(recordName)}</c> — every component nullable (null where lost/malformed).</summary>");
        sb.AppendLine($"public sealed record {recordName}");
        sb.AppendLine("{");
        foreach (var f in Fr010FieldMapping.Fields(vo))
            sb.AppendLine($"    public {Fr010FieldMapping.MirrorType(f)} {f.Name} {{ get; init; }}");
        sb.AppendLine("}");
        return sb.ToString();
    }

    /// <summary>Emit <c>new &lt;recordName&gt; { prop = RecoverMap.As*(d, "prop"), … }</c>.</summary>
    public static string MirrorInitializer(MetaData vo, string recordName)
    {
        var assigns = Fr010FieldMapping.Fields(vo).Select(f => $"{f.Name} = {Fr010FieldMapping.RecoverMapCall(f)}");
        return $"new {recordName} {{ {string.Join(", ", assigns)} }}";
    }

    // ---- helpers ----

    private static string RecordBase(string recordName) =>
        recordName.EndsWith("Recovered", System.StringComparison.Ordinal)
            ? recordName[..^"Recovered".Length] : recordName;

    private static string Bool(bool b) => b ? "true" : "false";
}
