// FR-010 Plan 2.1 (nested codegen gap) — the runtime-DELEGATING extract emitter (C# port).
//
// The self-contained ExtractLenient(string) path (ExtractSchemaEmitter + the baked ExtractSchema +
// ExtractMap reads) covers scalars / enums / scalar-arrays but leaves nested-object and
// array-of-object components NULL — the historical FR-010 codegen gap. This module emits the
// additive runtime-DELEGATING overload that CLOSES that gap by wrapping the runtime extract:
//
//   ExtractLenient(MetaObject mo, string text[, ExtractOptions opts]) -> ExtractionResult<<Name>Extracted>
//
// The delegating overload takes a runtime MetaObject (resolved by the caller from a
// MetaDataLoader's Root via its baked PAYLOAD_FQN — a convenience MetaDataLoader overload is
// emitted too) and delegates to MetaObjects.Codegen.Runtime.ExtractObject.Extract(mo, text,
// Format, opts), which assembles the FULL nested object graph reflection-free via the Phase A
// object model (MetaObject.NewInstance() + the MetaField SPI). It then maps the assembled
// ValueObject graph into the typed nullable mirror graph via generated From<VO>Extracted(...)
// mapper methods (payload + every reachable nested VO, deduped).
//
// This is the codegen-wrapping-runtime pattern (a generated DAO calling the dynamic-metadata
// runtime), mirroring the Java SpringOutputParserGenerator + Kotlin/TS/Python pilots. The
// generated mappers read the assembled graph through a tiny ReadProp() helper mirroring the
// MetaField GetValue SPI (ValueObject.Get(name)), so the emitted code stays self-sufficient and
// reflection-free / AOT-safe.

using System.Collections.Generic;
using System.Linq;
using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

internal static class ExtractDelegateEmitter
{
    // =========================================================================
    // VO / field discovery (object-before-isArray order — the cross-port fix)
    // =========================================================================

    internal static MetaData? FindObject(MetaData root, string name) =>
        root.OwnChildren().FirstOrDefault(c => c.Type == TYPE_OBJECT && c.Name == name);

    /// <summary>
    /// The <c>@objectRef</c> target VO for a nested-object field, or null when unresolvable.
    /// Matches by the bare ref first, then by the package-stripped short name. Shared with
    /// <see cref="ExtractorGenerator"/> (the extract tier walks the same VO graph).
    /// </summary>
    internal static MetaData? RefVo(MetaData field, MetaData root)
    {
        if (field.OwnAttr(FIELD_ATTR_OBJECT_REF) is not string objectRef) return null;
        var direct = FindObject(root, objectRef);
        if (direct is not null) return direct;
        int sep = objectRef.LastIndexOf(PACKAGE_SEPARATOR, System.StringComparison.Ordinal);
        return sep >= 0 ? FindObject(root, objectRef[(sep + PACKAGE_SEPARATOR.Length)..]) : null;
    }

    /// <summary>
    /// True iff the field is a nested object reference (<c>field.object</c>) — distinct from the
    /// string-backed <c>field.enum</c>, which is treated as a scalar. OBJECT is tested BEFORE
    /// IsArray (the object-before-isArray order) so an array-of-objects maps to nested mirrors,
    /// not a string list.
    /// </summary>
    internal static bool IsObjectField(MetaData field) => field.SubType == FIELD_SUBTYPE_OBJECT;

    /// <summary>The extracted-mirror record name for a value-object (<c>&lt;Name&gt;Extracted</c>).</summary>
    public static string MirrorName(MetaData vo) => $"{vo.Name}Extracted";

    /// <summary>The mapper-method name for a value-object (<c>From&lt;Name&gt;Extracted</c>).</summary>
    private static string MapperName(MetaData vo) => $"From{vo.Name}Extracted";

    // =========================================================================
    // "Has nested" — only emit the delegating overload + mappers when worthwhile
    // =========================================================================

    /// <summary>True iff the payload (or any reachable nested VO) has a nested-object / array-of-object field.</summary>
    public static bool HasNested(MetaData vo, MetaData root)
    {
        var seen = new HashSet<string>(System.StringComparer.Ordinal);
        var stack = new Stack<MetaData>();
        stack.Push(vo);
        while (stack.Count > 0)
        {
            var cur = stack.Pop();
            if (!seen.Add(cur.Name)) continue;
            foreach (var f in Fr010FieldMapping.Fields(cur))
            {
                if (!IsObjectField(f)) continue;
                var target = RefVo(f, root);
                if (target is not null) stack.Push(target);
                return true; // a nested object field exists regardless of resolvability
            }
        }
        return false;
    }

    // =========================================================================
    // Nested-aware mirror records (payload + every reachable nested VO)
    // =========================================================================

    /// <summary>The nullable mirror C# type for one field — nested-aware (recurses into nested mirror names).</summary>
    private static string NestedMirrorType(MetaData field, MetaData root)
    {
        // Object BEFORE array (the object-before-isArray fix): an array-of-objects must map to
        // a list of nested mirrors, NOT a string list.
        if (IsObjectField(field))
        {
            var target = RefVo(field, root);
            string baseName = target is not null ? MirrorName(target) : "object";
            return Fr010FieldMapping.IsArray(field)
                ? $"global::System.Collections.Generic.IReadOnlyList<{baseName}?>?"
                : $"{baseName}?";
        }
        // Scalar ARRAY: kind-type the element exactly as a SINGLE scalar would be typed, so the
        // mirror list element matches PayloadCodegen's strict element type (an int[] field strict-
        // types as IReadOnlyList<int>, so the mirror must be IReadOnlyList<int?>?, not <string?>?).
        if (Fr010FieldMapping.IsArray(field))
            return $"global::System.Collections.Generic.IReadOnlyList<{Fr010FieldMapping.ScalarMirrorType(field.SubType)}>?";
        return Fr010FieldMapping.ScalarMirrorType(field.SubType);
    }

    /// <summary>
    /// Emit the nested-aware mirror record for <paramref name="vo"/> and every value-object
    /// reachable from it (deduped by simple name; cycle-safe). The PAYLOAD mirror keeps the
    /// canonical <c>&lt;Payload&gt;Extracted</c> name (<paramref name="payloadMirror"/>) so the
    /// self-contained <c>ExtractLenient(string)</c> and the delegating overload share one mirror type.
    /// The nested mirror records are emitted here (the self-contained emitter only emits the
    /// payload mirror).
    /// </summary>
    /// <summary>
    /// Emit the PAYLOAD mirror record (nested-aware, so object fields are typed as nested mirrors,
    /// not <c>object?</c>) plus every reachable NESTED mirror record. Replaces the self-contained
    /// <see cref="ExtractSchemaEmitter.MirrorRecordDecl"/> on the delegating path so the one shared
    /// <c>&lt;Payload&gt;Extracted</c> type can carry populated nested components.
    /// </summary>
    public static string NestedMirrorRecords(MetaData vo, MetaData root, string payloadMirror)
    {
        var sb = new StringBuilder();
        var seen = new HashSet<string>(System.StringComparer.Ordinal);
        EmitMirror(vo, root, payloadMirror, seen, sb);
        return sb.ToString();
    }

    private static void EmitMirror(MetaData vo, MetaData root, string recordName,
        HashSet<string> seen, StringBuilder sb)
    {
        if (!seen.Add(vo.Name)) return;
        string baseName = recordName.EndsWith("Extracted", System.StringComparison.Ordinal)
            ? recordName[..^"Extracted".Length] : recordName;
        sb.AppendLine();
        sb.AppendLine($"/// <summary>Best-effort extracted twin of <c>{baseName}</c> — every component nullable (null where lost/malformed).</summary>");
        sb.AppendLine($"public sealed record {recordName}");
        sb.AppendLine("{");
        foreach (var f in Fr010FieldMapping.Fields(vo))
            sb.AppendLine($"    public {NestedMirrorType(f, root)} {f.Name} {{ get; init; }}");
        sb.AppendLine("}");

        foreach (var f in Fr010FieldMapping.Fields(vo))
            if (IsObjectField(f) && RefVo(f, root) is { } target)
                EmitMirror(target, root, MirrorName(target), seen, sb);
    }

    // =========================================================================
    // The delegating extract overload + ValueObject(map)->mirror mappers
    // =========================================================================

    /// <summary>
    /// Emit the runtime-delegating extract members appended inside the generated parser class:
    /// the <c>PAYLOAD_FQN</c> constant, the <c>ExtractLenient(MetaObject, ...)</c> + convenience
    /// <c>ExtractLenient(MetaDataLoader, ...)</c> overloads, the recursive <c>From&lt;VO&gt;Extracted</c>
    /// mappers (payload + nested, deduped), and the shared <c>ReadProp</c> / <c>MapObjectList</c>
    /// / <c>Dlg*</c> helpers.
    /// </summary>
    public static string DelegatingMembers(MetaData vo, MetaData root, string payloadFqn,
        string rootMirror, string formatEnum)
    {
        var sb = new StringBuilder();
        sb.AppendLine();
        sb.AppendLine("    // FR-010 Plan 2.1 — runtime-delegating extraction (closes the nested-object / array-of-object");
        sb.AppendLine("    // gap left by the self-contained ExtractLenient(string) path). Delegates to the runtime");
        sb.AppendLine("    // MetaObjects.Codegen.Runtime.ExtractObject, which assembles the FULL nested object graph");
        sb.AppendLine("    // reflection-free, then maps it into the typed nullable mirror via From*Extracted.");
        sb.AppendLine();
        sb.AppendLine($"    /// <summary>The payload's metadata name — resolve it against a loaded <c>MetaRoot</c> to obtain the runtime <c>MetaObject</c>.</summary>");
        sb.AppendLine($"    public const string PAYLOAD_FQN = \"{Fr010FieldMapping.CSharpStringLiteral(payloadFqn)}\";");
        sb.AppendLine();
        sb.AppendLine($"    /// <summary>Tolerant best-effort extraction delegating to the runtime; fully populates nested-object and");
        sb.AppendLine($"    /// array-of-object components (unlike the self-contained <see cref=\"ExtractLenient(string)\"/>). Never throws.</summary>");
        sb.AppendLine($"    public static global::MetaObjects.Render.Extract.ExtractionResult<{rootMirror}> ExtractLenient(");
        sb.AppendLine($"        global::MetaObjects.Meta.MetaObject mo, string text, ExtractOptions? opts = null)");
        sb.AppendLine("    {");
        sb.AppendLine($"        var raw = global::MetaObjects.Codegen.Runtime.ExtractObject.Extract(mo, text, {formatEnum}, opts);");
        sb.AppendLine("        // The assembled graph is a ValueObject (nested ValueObjects / lists of them) — map it into");
        sb.AppendLine("        // the typed mirror graph. ReadProp mirrors the MetaField GetValue SPI (reflection-free).");
        sb.AppendLine($"        var data = {vo.Name}ExtractedRoot(raw.Data);");
        sb.AppendLine($"        return new global::MetaObjects.Render.Extract.ExtractionResult<{rootMirror}>(data, raw.Report);");
        sb.AppendLine("    }");
        sb.AppendLine();
        sb.AppendLine($"    /// <summary>Convenience overload — resolves <see cref=\"PAYLOAD_FQN\"/> from a loaded <c>MetaRoot</c>, then delegates.</summary>");
        sb.AppendLine($"    public static global::MetaObjects.Render.Extract.ExtractionResult<{rootMirror}> ExtractLenient(");
        sb.AppendLine($"        global::MetaObjects.Meta.MetaRoot root, string text, ExtractOptions? opts = null)");
        sb.AppendLine("    {");
        sb.AppendLine("        var mo = root.FindObject(PAYLOAD_FQN)");
        sb.AppendLine("            ?? throw new global::System.InvalidOperationException(");
        sb.AppendLine("                $\"payload object \\\"{PAYLOAD_FQN}\\\" not found in the loaded metadata\");");
        sb.AppendLine("        return ExtractLenient(mo, text, opts);");
        sb.AppendLine("    }");

        // ---- mappers (root + nested, deduped). Root mapper is named distinctly so it can carry
        //      the canonical payload-mirror return type (the template name may differ from the VO).
        EmitMappers(sb, vo, root, rootMirror);

        // ---- shared helpers
        AppendHelpers(sb);
        return sb.ToString();
    }

    private static void EmitMappers(StringBuilder sb, MetaData rootVo, MetaData root, string rootMirror)
    {
        var seen = new HashSet<string>(System.StringComparer.Ordinal);
        // Root mapper: a distinctly-named method returning the canonical payload mirror.
        EmitRootMapper(sb, rootVo, root, rootMirror);
        seen.Add(rootVo.Name);
        // Nested mappers (each named From<VO>Extracted, returning <VO>Extracted).
        foreach (var f in Fr010FieldMapping.Fields(rootVo))
            if (IsObjectField(f) && RefVo(f, root) is { } target)
                EmitNestedMapper(sb, target, root, seen);
    }

    private static void EmitRootMapper(StringBuilder sb, MetaData vo, MetaData root, string mirror)
    {
        sb.AppendLine();
        sb.AppendLine($"    /// <summary>Map an assembled ValueObject graph into a typed <c>{mirror}</c>. Generated; null-tolerant.</summary>");
        sb.AppendLine($"    private static {mirror}? {vo.Name}ExtractedRoot(object? o)");
        sb.AppendLine("    {");
        sb.AppendLine("        if (o is null) return null;");
        sb.AppendLine($"        return new {mirror}");
        sb.AppendLine("        {");
        foreach (var f in Fr010FieldMapping.Fields(vo))
            sb.AppendLine($"            {f.Name} = {MapperArg(f, root)},");
        sb.AppendLine("        };");
        sb.AppendLine("    }");
    }

    private static void EmitNestedMapper(StringBuilder sb, MetaData vo, MetaData root, HashSet<string> seen)
    {
        if (!seen.Add(vo.Name)) return;
        string mirror = MirrorName(vo);
        sb.AppendLine();
        sb.AppendLine($"    /// <summary>Map an assembled ValueObject graph into a typed <c>{mirror}</c>. Generated; null-tolerant.</summary>");
        sb.AppendLine($"    private static {mirror}? {MapperName(vo)}(object? o)");
        sb.AppendLine("    {");
        sb.AppendLine("        if (o is null) return null;");
        sb.AppendLine($"        return new {mirror}");
        sb.AppendLine("        {");
        foreach (var f in Fr010FieldMapping.Fields(vo))
            sb.AppendLine($"            {f.Name} = {MapperArg(f, root)},");
        sb.AppendLine("        };");
        sb.AppendLine("    }");

        foreach (var f in Fr010FieldMapping.Fields(vo))
            if (IsObjectField(f) && RefVo(f, root) is { } target)
                EmitNestedMapper(sb, target, root, seen);
    }

    /// <summary>The mirror-field initializer expression that reads <paramref name="field"/> from the assembled object.</summary>
    private static string MapperArg(MetaData field, MetaData root)
    {
        string key = $"\"{Fr010FieldMapping.CSharpStringLiteral(field.Name)}\"";

        // Object BEFORE array (object-before-isArray): array-of-objects maps to nested mirrors.
        if (IsObjectField(field))
        {
            var target = RefVo(field, root);
            if (target is null) return "null /* unresolved @objectRef */";
            string fn = MapperName(target);
            return Fr010FieldMapping.IsArray(field)
                ? $"MapObjectList(ReadProp(o, {key}), {fn})"
                : $"{fn}(ReadProp(o, {key}))";
        }

        // Enum / scalar / scalar-array: the runtime already coerced; read + light-coerce via Dlg*.
        // A scalar ARRAY maps each element through the SAME per-kind Dlg* reader the single scalar
        // uses, so the produced element type matches the kind-typed mirror list (int?/long?/...).
        // IsArray is checked BEFORE the single-scalar enum return so an ENUM array routes through the
        // string-LIST reader (DlgList(..., DlgString)), matching its IReadOnlyList<string?>? mirror —
        // NOT the single DlgString reader (the enum-before-isArray ordering fix).
        if (Fr010FieldMapping.IsArray(field))
        {
            string elemReader = field.SubType == FIELD_SUBTYPE_ENUM ? "DlgString" : ScalarReader(field.SubType);
            return $"DlgList(ReadProp(o, {key}), {elemReader})";
        }
        if (field.SubType == FIELD_SUBTYPE_ENUM) return $"DlgString(ReadProp(o, {key}))";
        return $"{ScalarReader(field.SubType)}(ReadProp(o, {key}))";
    }

    /// <summary>The per-kind <c>Dlg*</c> nullable-scalar reader name for a (non-enum) scalar subtype.</summary>
    private static string ScalarReader(string subType) => Fr010FieldMapping.ScalarKind(subType) switch
    {
        "Int" => "DlgInt",
        "Long" => "DlgLong",
        "Double" => "DlgDouble",
        "Boolean" => "DlgBool",
        _ => "DlgString",
    };

    /// <summary>
    /// Append the shared runtime-delegating helpers the mappers rely on. <c>ReadProp</c> mirrors
    /// the MetaField GetValue SPI (<c>ValueObject.Get(name)</c>) so the mappers stay reflection-free
    /// + backing-agnostic; <c>MapObjectList</c> maps an assembled list element-wise; the <c>Dlg*</c>
    /// readers light-coerce to the mirror's nullable scalar shapes. (The <c>Dlg</c> prefix avoids
    /// shadowing the render <c>ExtractMap.As*(d, key)</c> two-arg readers the self-contained path uses.)
    /// </summary>
    private static void AppendHelpers(StringBuilder sb)
    {
        sb.AppendLine();
        sb.AppendLine("    // ---- runtime-delegating extract helpers (generated) ----");
        sb.AppendLine();
        sb.AppendLine("    /// <summary>Read a property from an assembled backing object, mirroring the MetaField GetValue SPI.</summary>");
        sb.AppendLine("    private static object? ReadProp(object? o, string name) =>");
        sb.AppendLine("        o is global::MetaObjects.Meta.ValueObject vo ? vo.Get(name) : null;");
        sb.AppendLine();
        sb.AppendLine("    /// <summary>Map each element of an assembled list via <paramref name=\"fn\"/>; null/absent -> null.</summary>");
        sb.AppendLine("    private static global::System.Collections.Generic.IReadOnlyList<T?>? MapObjectList<T>(");
        sb.AppendLine("        object? v, global::System.Func<object?, T?> fn) where T : class");
        sb.AppendLine("    {");
        sb.AppendLine("        if (v is not global::System.Collections.IEnumerable e || v is string) return null;");
        sb.AppendLine("        var outList = new global::System.Collections.Generic.List<T?>();");
        sb.AppendLine("        foreach (var elem in e) outList.Add(fn(elem));");
        sb.AppendLine("        return outList;");
        sb.AppendLine("    }");
        sb.AppendLine();
        sb.AppendLine("    private static string? DlgString(object? v) => v?.ToString();");
        sb.AppendLine();
        sb.AppendLine("    private static int? DlgInt(object? v) => v switch");
        sb.AppendLine("    {");
        sb.AppendLine("        null => null,");
        sb.AppendLine("        int i => i,");
        sb.AppendLine("        long l => unchecked((int)l),");
        sb.AppendLine("        global::System.IConvertible => global::System.Convert.ToInt32(v, global::System.Globalization.CultureInfo.InvariantCulture),");
        sb.AppendLine("        _ => int.TryParse(v.ToString(), out var n) ? n : (int?)null,");
        sb.AppendLine("    };");
        sb.AppendLine();
        sb.AppendLine("    private static long? DlgLong(object? v) => v switch");
        sb.AppendLine("    {");
        sb.AppendLine("        null => null,");
        sb.AppendLine("        long l => l,");
        sb.AppendLine("        int i => i,");
        sb.AppendLine("        global::System.IConvertible => global::System.Convert.ToInt64(v, global::System.Globalization.CultureInfo.InvariantCulture),");
        sb.AppendLine("        _ => long.TryParse(v.ToString(), out var n) ? n : (long?)null,");
        sb.AppendLine("    };");
        sb.AppendLine();
        sb.AppendLine("    private static double? DlgDouble(object? v) => v switch");
        sb.AppendLine("    {");
        sb.AppendLine("        null => null,");
        sb.AppendLine("        double d => d,");
        sb.AppendLine("        global::System.IConvertible => global::System.Convert.ToDouble(v, global::System.Globalization.CultureInfo.InvariantCulture),");
        sb.AppendLine("        _ => double.TryParse(v.ToString(), global::System.Globalization.NumberStyles.Any, global::System.Globalization.CultureInfo.InvariantCulture, out var n) ? n : (double?)null,");
        sb.AppendLine("    };");
        sb.AppendLine();
        sb.AppendLine("    private static bool? DlgBool(object? v) => v switch");
        sb.AppendLine("    {");
        sb.AppendLine("        null => null,");
        sb.AppendLine("        bool b => b,");
        sb.AppendLine("        _ => string.Equals(v.ToString(), \"true\", global::System.StringComparison.OrdinalIgnoreCase),");
        sb.AppendLine("    };");
        sb.AppendLine();
        sb.AppendLine("    /// <summary>Map an assembled scalar list element-wise via <paramref name=\"fn\"/> into a kind-typed nullable-element list.");
        sb.AppendLine("    /// Two overloads (value-type struct element vs reference-type string element) keep the element nullable for both.</summary>");
        sb.AppendLine("    private static global::System.Collections.Generic.IReadOnlyList<T?>? DlgList<T>(");
        sb.AppendLine("        object? v, global::System.Func<object?, T?> fn) where T : struct");
        sb.AppendLine("    {");
        sb.AppendLine("        if (v is not global::System.Collections.IEnumerable e || v is string) return null;");
        sb.AppendLine("        var outList = new global::System.Collections.Generic.List<T?>();");
        sb.AppendLine("        foreach (var elem in e) outList.Add(fn(elem));");
        sb.AppendLine("        return outList;");
        sb.AppendLine("    }");
        sb.AppendLine();
        sb.AppendLine("    private static global::System.Collections.Generic.IReadOnlyList<T?>? DlgList<T>(");
        sb.AppendLine("        object? v, global::System.Func<object?, T?> fn) where T : class");
        sb.AppendLine("    {");
        sb.AppendLine("        if (v is not global::System.Collections.IEnumerable e || v is string) return null;");
        sb.AppendLine("        var outList = new global::System.Collections.Generic.List<T?>();");
        sb.AppendLine("        foreach (var elem in e) outList.Add(fn(elem));");
        sb.AppendLine("        return outList;");
        sb.AppendLine("    }");
    }
}
