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

using System.Collections.Generic;
using System.Linq;
using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

internal static class RecoverSchemaEmitter
{
    private static IEnumerable<MetaData> Fields(MetaData vo) =>
        vo.Children().Where(c => c.Type == TYPE_FIELD);

    /// <summary>Emit <c>new RecoverSchema(Format.X, "rootName", new FieldSpec[] { … })</c>.</summary>
    public static string SchemaLiteral(MetaData vo, string format, string rootName)
    {
        string formatEnum = format.Equals("xml", System.StringComparison.OrdinalIgnoreCase)
            ? "Format.Xml" : "Format.Json";
        var specs = Fields(vo).Select(FieldSpecLiteral);
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
        var values = EnumValues(field);
        string valuesLit = "new[] { " + string.Join(", ", values.Select(v => $"\"{v}\"")) + " }";

        var aliases = AsStringMap(field.OwnAttr(FIELD_ATTR_ENUM_ALIAS));
        string aliasLit = aliases.Count == 0 ? "null" : DictLiteral(aliases);

        return $"FieldSpec.EnumField(\"{name}\", {Bool(required)}, {valuesLit}, {aliasLit})";
    }

    /// <summary>Emit the all-nullable mirror record declaration.</summary>
    public static string MirrorRecordDecl(MetaData vo, string recordName)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"/// <summary>Best-effort recovered twin of <c>{RecordBase(recordName)}</c> — every component nullable (null where lost/malformed).</summary>");
        sb.AppendLine($"public sealed record {recordName}");
        sb.AppendLine("{");
        foreach (var f in Fields(vo))
            sb.AppendLine($"    public {Fr010FieldMapping.MirrorType(f)} {f.Name} {{ get; init; }}");
        sb.AppendLine("}");
        return sb.ToString();
    }

    /// <summary>Emit <c>new &lt;recordName&gt; { prop = RecoverMap.As*(d, "prop"), … }</c>.</summary>
    public static string MirrorInitializer(MetaData vo, string recordName)
    {
        var assigns = Fields(vo).Select(f => $"{f.Name} = {Fr010FieldMapping.RecoverMapCall(f)}");
        return $"new {recordName} {{ {string.Join(", ", assigns)} }}";
    }

    // ---- helpers ----

    private static string RecordBase(string recordName) =>
        recordName.EndsWith("Recovered", System.StringComparison.Ordinal)
            ? recordName[..^"Recovered".Length] : recordName;

    private static IReadOnlyList<string> EnumValues(MetaData field)
    {
        var raw = field.OwnAttr(FIELD_ATTR_VALUES);
        return raw switch
        {
            IReadOnlyList<string> ss => ss,
            IReadOnlyList<object?> os => os.Select(o => o?.ToString() ?? "").ToList(),
            _ => new List<string>(),
        };
    }

    private static IReadOnlyDictionary<string, string> AsStringMap(object? attr)
    {
        if (attr is not IReadOnlyDictionary<string, object?> d) return new Dictionary<string, string>();
        var result = new Dictionary<string, string>();
        foreach (var (k, v) in d)
            if (v is not null) result[k] = v.ToString()!;
        return result;
    }

    private static string DictLiteral(IReadOnlyDictionary<string, string> map)
    {
        // Keys sorted for deterministic output (matches the canonical-serializer properties sort).
        var entries = map.OrderBy(kv => kv.Key, System.StringComparer.Ordinal)
            .Select(kv => $"[\"{Fr010FieldMapping.CSharpStringLiteral(kv.Key)}\"] = \"{Fr010FieldMapping.CSharpStringLiteral(kv.Value)}\"");
        return "new Dictionary<string, string> { " + string.Join(", ", entries) + " }";
    }

    private static string Bool(bool b) => b ? "true" : "false";
}
