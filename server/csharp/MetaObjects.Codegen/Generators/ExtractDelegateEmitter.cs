// FR-010 — the runtime-DELEGATING extract emitter (C# port): the single metadata-driven
// extract path.
//
// This module emits the loader-delegating extract overloads that read the live metadata
// directly and populate the FULL object graph (scalars / enums / scalar-arrays + nested-object
// and array-of-object components):
//
//   ExtractLenient(MetaObject mo, string text[, ExtractOptions opts]) -> ExtractionResult<<Name>Extracted>
//
// The delegating overload takes a runtime MetaObject (resolved by the caller from a
// MetaDataLoader's Root via its baked PAYLOAD_FQN — a convenience MetaRoot overload is
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

// Eject (ADR-0034 Amendment 3): not itself ejectable, but ExtractorGenerator /
// OutputParserGenerator (which ARE) call into it, so it — and the members below that
// used to be internal-only — must be public API for an ejected copy to resolve them.
public static class ExtractDelegateEmitter
{
    // =========================================================================
    // VO / field discovery (object-before-isArray order — the cross-port fix)
    // =========================================================================

    /// <summary>
    /// Resolve an OBJECT reference under the ADR-0042 package-local contract (FQN-exact when
    /// qualified; else the referrer's own package, else root-level) — never a bare-tail
    /// fallback (the #219/#228 "wrong node" class: under a cross-package short-name collision,
    /// a bare-tail match binds WHICHEVER same-named object happens to load first, regardless of
    /// which package <paramref name="name"/> actually points at).
    /// </summary>
    public static MetaData? FindObject(MetaData root, string name, string referrerPkg) =>
        global::MetaObjects.NamingRefs.ResolveObjectRef(root, name, referrerPkg);

    /// <summary>
    /// The <c>@objectRef</c> target VO for a nested-object field, or null when unresolvable.
    /// The referrer package is the FIELD's own declaring package (ADR-0042 — the field's parent
    /// object, not necessarily the walk's root VO, since a field may be inherited via extends
    /// from an abstract VO declared in a different package). Shared with
    /// <see cref="ExtractorGenerator"/> (the extract tier walks the same VO graph).
    /// </summary>
    public static MetaData? RefVo(MetaData field, MetaData root)
    {
        // ADR-0039: resolving — @objectRef may be inherited via extends (TS reads f.attr).
        if (field.Attr(FIELD_ATTR_OBJECT_REF) is not string objectRef) return null;
        var referrerPkg = field.Parent is not null
            ? global::MetaObjects.NamingRefs.EffectivePackage(field.Parent)
            : "";
        return FindObject(root, objectRef, referrerPkg);
    }

    /// <summary>
    /// True iff the field is a nested object reference (<c>field.object</c>) — distinct from the
    /// string-backed <c>field.enum</c>, which is treated as a scalar. OBJECT is tested BEFORE
    /// IsArray (the object-before-isArray order) so an array-of-objects maps to nested mirrors,
    /// not a string list.
    /// </summary>
    public static bool IsObjectField(MetaData field) => field.SubType == FIELD_SUBTYPE_OBJECT;

    /// <summary>The extracted-mirror record name for a value object: <c>&lt;TypeName&gt;Extracted</c>,
    /// where <c>TypeName</c> is the value object's own emitted name (ADR-0056 — the mirror is keyed
    /// by the value object, never by a template).</summary>
    public static string MirrorName(MetaData vo, MetaData root) =>
        $"{ValueObjectNames.TypeName(vo, root)}Extracted";

    /// <summary>How code in <paramref name="fromNamespace"/> names <paramref name="vo"/>'s mirror,
    /// which lives in the value object's own namespace.</summary>
    public static string MirrorRef(MetaData vo, MetaData root, GenConfig config, string fromNamespace)
    {
        var ns = ValueObjectNames.Namespace(vo, config);
        var name = MirrorName(vo, root);
        return ns == fromNamespace ? name : $"global::{ns}.{name}";
    }

    /// <summary>The mapper-method name for a value object (<c>From&lt;TypeName&gt;Extracted</c>).</summary>
    private static string MapperName(MetaData vo, MetaData root) =>
        $"From{ValueObjectNames.TypeName(vo, root)}Extracted";

    /// <summary>Every value object a mirror of <paramref name="vo"/> reaches — itself, then each
    /// nested <c>@objectRef</c> target, depth-first — deduped by FQN (cycle-safe).</summary>
    public static IReadOnlyList<MetaData> MirrorClosure(MetaData vo, MetaData root)
    {
        var seen = new HashSet<string>(System.StringComparer.Ordinal);
        var order = new List<MetaData>();
        Walk(vo);
        return order;

        void Walk(MetaData node)
        {
            if (!seen.Add(node.ResolutionKey())) return;
            order.Add(node);
            foreach (var f in Fr010FieldMapping.Fields(node))
                if (IsObjectField(f) && RefVo(f, root) is { } target)
                    Walk(target);
        }
    }

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
            // Dedupe by ResolutionKey (FQN) — NOT the bare Name — so a cross-package same-short-
            // named VO reached from a DIFFERENT branch is still walked (the #219-class defect:
            // bare-name dedupe would prune it as "already seen" and could miss its nested fields).
            if (!seen.Add(cur.ResolutionKey())) continue;
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
    private static string NestedMirrorType(MetaData field, MetaData root, GenConfig config, string fromNamespace)
    {
        // Object BEFORE array (the object-before-isArray fix): an array-of-objects must map to
        // a list of nested mirrors, NOT a string list.
        if (IsObjectField(field))
        {
            var target = RefVo(field, root);
            string baseName = target is not null ? MirrorRef(target, root, config, fromNamespace) : "object";
            return Fr010FieldMapping.IsArray(field)
                ? $"global::System.Collections.Generic.IReadOnlyList<{baseName}?>?"
                : $"{baseName}?";
        }
        // Scalar ARRAY: kind-type the element exactly as a SINGLE scalar would be typed, so an
        // int[] field mirrors as IReadOnlyList<int?>?, not <string?>?.
        if (Fr010FieldMapping.IsArray(field))
            return $"global::System.Collections.Generic.IReadOnlyList<{Fr010FieldMapping.ScalarMirrorType(field.SubType)}>?";
        return Fr010FieldMapping.ScalarMirrorType(field.SubType);
    }

    /// <summary>
    /// ADR-0056 rule 3 — the file declaring <paramref name="vo"/>'s all-nullable mirror
    /// (<c>&lt;TypeName&gt;Extracted</c>), in the value object's own namespace. A run emits it ONCE
    /// per value object, however many parsers reach it, so where it lands never depends on which
    /// template came first. Nested object fields are typed as the nested value objects' mirrors.
    /// </summary>
    public static EmittedFile MirrorFile(MetaData vo, MetaData root, GenConfig config)
    {
        var ns = ValueObjectNames.Namespace(vo, config);
        var name = MirrorName(vo, root);
        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects output-parser-generator. Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine();
        sb.AppendLine($"namespace {ns};");
        sb.AppendLine();
        sb.AppendLine($"/// <summary>Best-effort extracted twin of <c>{ValueObjectNames.TypeName(vo, root)}</c> — every component nullable (null where lost/malformed).</summary>");
        sb.AppendLine($"public sealed record {name}");
        sb.AppendLine("{");
        foreach (var f in Fr010FieldMapping.Fields(vo))
            sb.AppendLine($"    public {NestedMirrorType(f, root, config, ns)} {f.Name} {{ get; init; }}");
        sb.AppendLine("}");
        return new EmittedFile($"{name}.g.cs", sb.ToString());
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
    public static string DelegatingMembers(MetaData vo, MetaData root, GenConfig config,
        string fromNamespace, string formatEnum)
    {
        string rootMirror = MirrorRef(vo, root, config, fromNamespace);

        // ADR-0044/#228 fix round 1 — root.FindObject(name) (MetaRoot's public runtime API) is
        // a bare-Name-only, first-match lookup with NO package awareness. Extractors and
        // output-parsers emit into ONE FLAT namespace (config.Namespace), while entities and
        // value-object POCOs can emit into PER-PACKAGE namespaces (FR-019
        // PackageBindingResolver) — so two DIFFERENT-package objects sharing this payload's bare
        // short name (e.g. an object.value "Report" used as this @payloadRef in one package, and
        // an unrelated object.entity "Report" in another) can BOTH load and compile cleanly (no
        // duplicate-type error, since they land in different namespaces), yet
        // root.FindObject(bareName) at RUNTIME silently binds whichever one loaded first —
        // reachable, compiling, silent wrong-node extraction. Bake the FULL ResolutionKey (FQN)
        // and resolve via the canonical NamingRefs.ResolveObjectRef matcher (FQN-exact,
        // load-order-independent) ONLY when this payload's bare name is actually AMBIGUOUS at
        // the metadata root (more than one root-level object.* shares it — the SAME domain
        // MetaRoot.FindObject itself searches). A UNIQUE (the overwhelmingly common) payload
        // name keeps TODAY'S exact bare-name + root.FindObject() path, byte-identical to
        // pre-fix output — a naive "always bake the FQN" would REGRESS the unique case, since
        // MetaRoot.FindObject matches bare child names only and would return null for an FQN.
        bool payloadNameAmbiguous = root.Children().Count(c => c.Type == TYPE_OBJECT && c.Name == vo.Name) > 1;
        string bakedPayloadFqn = payloadNameAmbiguous ? vo.ResolutionKey() : vo.Name;

        var sb = new StringBuilder();
        sb.AppendLine();
        sb.AppendLine("    // FR-010 — runtime-delegating extraction (the single metadata-driven extract path).");
        sb.AppendLine("    // Delegates to the runtime MetaObjects.Codegen.Runtime.ExtractObject, which assembles the");
        sb.AppendLine("    // FULL object graph (nested objects + arrays-of-objects) reflection-free by reading the live");
        sb.AppendLine("    // metadata, then maps it into the typed nullable mirror via From*Extracted.");
        sb.AppendLine();
        var ambiguousNote = payloadNameAmbiguous
            ? " ADR-0042 FQN (this payload's bare name collides with a same-short-name object elsewhere in the run)."
            : "";
        sb.AppendLine($"    /// <summary>The payload's metadata name — resolve it against a loaded <c>MetaRoot</c> to obtain the runtime <c>MetaObject</c>.{ambiguousNote}</summary>");
        sb.AppendLine($"    public const string PAYLOAD_FQN = \"{Fr010FieldMapping.CSharpStringLiteral(bakedPayloadFqn)}\";");
        sb.AppendLine();
        sb.AppendLine($"    /// <summary>Tolerant best-effort extraction delegating to the runtime; fully populates nested-object and");
        sb.AppendLine($"    /// array-of-object components by reading the live metadata. Never throws.</summary>");
        sb.AppendLine($"    public static global::MetaObjects.Render.Extract.ExtractionResult<{rootMirror}> ExtractLenient(");
        sb.AppendLine($"        global::MetaObjects.Meta.MetaObject mo, string text, ExtractOptions? opts = null)");
        sb.AppendLine("    {");
        sb.AppendLine($"        var raw = global::MetaObjects.Codegen.Runtime.ExtractObject.Extract(mo, text, {formatEnum}, opts);");
        sb.AppendLine("        // The assembled graph is a ValueObject (nested ValueObjects / lists of them) — map it into");
        sb.AppendLine("        // the typed mirror graph. ReadProp mirrors the MetaField GetValue SPI (reflection-free).");
        sb.AppendLine($"        var data = {MapperName(vo, root)}(raw.Data);");
        sb.AppendLine($"        return new global::MetaObjects.Render.Extract.ExtractionResult<{rootMirror}>(data, raw.Report);");
        sb.AppendLine("    }");
        sb.AppendLine();
        sb.AppendLine($"    /// <summary>Convenience overload — resolves <see cref=\"PAYLOAD_FQN\"/> from a loaded <c>MetaRoot</c>, then delegates.</summary>");
        sb.AppendLine($"    public static global::MetaObjects.Render.Extract.ExtractionResult<{rootMirror}> ExtractLenient(");
        sb.AppendLine($"        global::MetaObjects.Meta.MetaRoot root, string text, ExtractOptions? opts = null)");
        sb.AppendLine("    {");
        // NamingRefs.ResolveObjectRef returns MetaData?; ExtractLenient(MetaObject, ...) needs a
        // MetaObject — the "as" narrows (never a hard cast throw) matching root.FindObject's own
        // MetaObject? return type on the unique path.
        sb.AppendLine(payloadNameAmbiguous
            ? "        var mo = global::MetaObjects.NamingRefs.ResolveObjectRef(root, PAYLOAD_FQN, \"\") as global::MetaObjects.Meta.MetaObject"
            : "        var mo = root.FindObject(PAYLOAD_FQN)");
        sb.AppendLine("            ?? throw new global::System.InvalidOperationException(");
        sb.AppendLine("                $\"payload object \\\"{PAYLOAD_FQN}\\\" not found in the loaded metadata\");");
        sb.AppendLine("        return ExtractLenient(mo, text, opts);");
        sb.AppendLine("    }");

        // ---- mappers: one From<TypeName>Extracted per value object the mirror reaches (the
        //      root included), deduped by FQN — so a nested reference back to the root resolves.
        foreach (var v in MirrorClosure(vo, root))
            EmitMapper(sb, v, root, config, fromNamespace);

        // ---- shared helpers
        AppendHelpers(sb);
        return sb.ToString();
    }

    private static void EmitMapper(StringBuilder sb, MetaData vo, MetaData root, GenConfig config, string fromNamespace)
    {
        string mirror = MirrorRef(vo, root, config, fromNamespace);
        sb.AppendLine();
        sb.AppendLine($"    /// <summary>Map an assembled ValueObject graph into a typed <c>{MirrorName(vo, root)}</c>. Generated; null-tolerant.</summary>");
        sb.AppendLine($"    private static {mirror}? {MapperName(vo, root)}(object? o)");
        sb.AppendLine("    {");
        sb.AppendLine("        if (o is null) return null;");
        sb.AppendLine($"        return new {mirror}");
        sb.AppendLine("        {");
        foreach (var f in Fr010FieldMapping.Fields(vo))
            sb.AppendLine($"            {f.Name} = {MapperArg(f, root)},");
        sb.AppendLine("        };");
        sb.AppendLine("    }");
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
            string fn = MapperName(target, root);
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

    /// <summary>
    /// The per-kind <c>Dlg*</c> nullable-scalar reader name for a (non-enum) scalar subtype.
    ///
    /// <para>MUST stay exhaustive over every kind <see cref="Fr010FieldMapping.ScalarKind"/> can
    /// return, because this reader is assigned into a mirror property typed by
    /// <see cref="Fr010FieldMapping.ScalarMirrorType"/> — and the delegating mirror types a scalar
    /// ARRAY's element the same way (<see cref="NestedMirrorType"/>), so a missing kind breaks both
    /// positions. A kind that falls through to the <c>DlgString</c> default while
    /// <c>ScalarMirrorType</c> gives it a value type emits code that does not compile: <c>Decimal</c>
    /// was missing here, producing <c>CS0029 string -> decimal?</c> on a single field and
    /// <c>CS0266 IReadOnlyList&lt;string?&gt; -> IReadOnlyList&lt;decimal?&gt;</c> on an array.
    /// Only the DELEGATING path was affected (a nested / array-of-object reach); a flat top-level
    /// payload goes through <see cref="Fr010FieldMapping.ExtractMapCall"/>, which always had its
    /// Decimal branch. Gated per-subtype by Fr010DelegatingMirrorLockStepTests.</para>
    /// </summary>
    private static string ScalarReader(string subType) => Fr010FieldMapping.ScalarKind(subType) switch
    {
        "Int" => "DlgInt",
        "Long" => "DlgLong",
        "Double" => "DlgDouble",
        "Decimal" => "DlgDecimal",
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
        // Mirrors ExtractMap.AsDecimal's never-throws contract (the self-contained path's reader):
        // integer kinds widen losslessly, a boxed double/float converts (lossy by nature of the
        // source), anything non-numeric is null. The explicit range guard is what keeps the cast
        // from throwing OverflowException — `(decimal)db` does, and a LENIENT extract must degrade
        // an out-of-range number to null rather than blow up the whole parse. The bound is a
        // conservative literal below decimal.MaxValue (7.9228e28) because (double)decimal.MaxValue
        // rounds UP, so comparing against it would admit values that still overflow the cast.
        // NaN / +-Infinity fail the range test and fall to null for free.
        sb.AppendLine("    private static decimal? DlgDecimal(object? v) => v switch");
        sb.AppendLine("    {");
        sb.AppendLine("        null => null,");
        sb.AppendLine("        decimal m => m,");
        sb.AppendLine("        long l => l,");
        sb.AppendLine("        int i => i,");
        sb.AppendLine("        short s => s,");
        sb.AppendLine("        byte b => b,");
        sb.AppendLine("        double db => db is >= -7.9e28 and <= 7.9e28 ? (decimal)db : (decimal?)null,");
        sb.AppendLine("        float f => f is >= -7.9e28f and <= 7.9e28f ? (decimal)f : (decimal?)null,");
        sb.AppendLine("        _ => decimal.TryParse(v.ToString(), global::System.Globalization.NumberStyles.Float | global::System.Globalization.NumberStyles.AllowThousands, global::System.Globalization.CultureInfo.InvariantCulture, out var n) ? n : (decimal?)null,");
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
