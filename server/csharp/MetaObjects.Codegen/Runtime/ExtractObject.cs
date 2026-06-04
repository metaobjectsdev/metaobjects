// Phase B (metadata-driven extract) runtime entry point — the keystone that turns dirty
// LLM text into a populated, typed object graph.
//
// This is the runtime bridge between the two halves of the standard:
//   • the extract ENGINE (MetaObjects.Render.Extract: ExtractSchema / FieldSpec / Extract) —
//     parses dirty JSON/XML into a forgiving Dictionary/List tree + a ExtractionReport;
//   • the Phase A runtime object model (MetaObjects.Meta: MetaObject.NewInstance() +
//     MetaField get/set SPI + @objectRef resolution) — instantiates the right backing
//     type (ValueObject or a registered/bound type) with the correct back-reference.
//
// SITING. MetaObjects.Render is zero-core-dependency by design (it cannot see MetaObject),
// and MetaObjects (core) sits below Render in the reference graph; neither can host a bridge
// that needs both. MetaObjects.Codegen references BOTH, so it is the natural higher home for
// this runtime API — mirroring the Java port's siting in the `om` (ObjectManager) module and
// the TS port's siting in `runtime-ts`. Render stays metadata-free.
//
// CONTRACT. Extract(...) NEVER throws: lost/malformed fields are classified in the report,
// never raised. Opt into strictness with ExtractionResult<T>.OrThrow() (in Render), which throws
// a ExtractException iff a required field was lost.
//
// REFLECTION-FREE. Assembly uses MetaObject.NewInstance() (the AOT-safe ObjectClassRegistry
// resolves the bound factory, else a ValueObject) and the MetaField set-by-name SPI —
// no Type.GetType / Activator / PropertyInfo. AOT / trimming safe (ADR-0001).

using System.Collections.Generic;
using System.Linq;
using MetaObjects.Meta;
using MetaObjects.Render.Extract;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Runtime;

/// <summary>
/// Runtime bridge that extracts dirty model output into a populated, typed object graph
/// described by a <see cref="MetaObject"/>. Never throws; <see cref="ExtractionResult{T}.OrThrow"/>
/// is the opt-in strict gate.
/// </summary>
public static class ExtractObject
{
    /// <summary>
    /// Maximum nested-object recursion depth. Mirrors the render <c>OutputFormatRenderer</c>
    /// (and FR-012) — must stay identical cross-port. At or beyond this depth a nested OBJECT
    /// field becomes an opaque STRING leaf instead of recursing.
    /// </summary>
    public const int MAX_NEST_DEPTH = 8;

    // =========================================================================
    // Public API
    // =========================================================================

    /// <summary>
    /// Extract <paramref name="text"/> into a typed object graph described by <paramref name="mo"/>.
    ///
    /// <para>Pipeline: build a <see cref="ExtractSchema"/> from <paramref name="mo"/> (driven
    /// entirely by metadata), run the engine to get a forgiving tree + report, then
    /// <see cref="Assemble(MetaObject, IReadOnlyDictionary{string, object?})">assemble</see> that
    /// tree into a populated object graph.</para>
    /// </summary>
    /// <param name="mo">the object describing the expected shape (the single source of truth)</param>
    /// <param name="text">the dirty model output</param>
    /// <param name="format">JSON or XML — drives the engine's locate/parse (default JSON)</param>
    /// <param name="opts">bounded runtime overrides (aliases/normalizers/onField/tolerance)</param>
    /// <returns>assembled object + report; NEVER null; NEVER throws.</returns>
    public static ExtractionResult<object> Extract(
        MetaObject mo,
        string? text,
        Format format = Format.Json,
        ExtractOptions? opts = null)
    {
        ExtractSchema schema = ExtractSchemaFor(mo, format);
        ExtractionOutcome outcome = Render.Extract.ExtractEngine.Run(text, schema, opts ?? ExtractOptions.Defaults());
        object obj = Assemble(mo, outcome.Data);
        return new ExtractionResult<object>(obj, outcome.Report);
    }

    // =========================================================================
    // ExtractSchemaFor — metadata -> ExtractSchema
    // =========================================================================

    /// <summary>
    /// Build a <see cref="ExtractSchema"/> for <paramref name="mo"/> by walking its
    /// effective fields and mapping each <see cref="MetaField"/> to a <see cref="FieldSpec"/>.
    /// Recurses into nested OBJECT fields via <c>@objectRef</c>, guarded against cycles/over-depth.
    /// </summary>
    public static ExtractSchema ExtractSchemaFor(MetaObject mo, Format format = Format.Json) =>
        ExtractSchemaFor(mo, format, NewVisited(), 0);

    private static ExtractSchema ExtractSchemaFor(MetaObject mo, Format format,
        HashSet<MetaObject> visited, int depth)
    {
        visited.Add(mo);
        var fields = new List<FieldSpec>();
        foreach (MetaField field in mo.Fields())
            fields.Add(FieldSpecFor(field, mo, format, visited, depth));
        visited.Remove(mo);
        // rootName is the simple (short) name; the engine's XML locate uses it as the root tag.
        return new ExtractSchema(format, mo.Name, fields);
    }

    private static FieldSpec FieldSpecFor(MetaField field, MetaObject owner, Format format,
        HashSet<MetaObject> visited, int depth)
    {
        string name = field.Name;
        bool required = field.IsRequired;

        // --- Enum (scalar or array) -----------------------------------------
        if (field.SubType == FIELD_SUBTYPE_ENUM)
        {
            IReadOnlyList<string> values = EnumValues(field);
            IReadOnlyDictionary<string, string> aliases = EnumAliases(field);
            string? coerceDefault = OwnAttrString(field, FIELD_ATTR_COERCE_DEFAULT);
            string? defaultValue = OwnAttrString(field, FIELD_ATTR_DEFAULT);
            NormalizeMode normalize = ResolveNormalize(field, owner);
            return IsArrayType(field)
                ? FieldSpec.EnumArray(name, required, values, aliases, coerceDefault, normalize, defaultValue)
                : FieldSpec.EnumField(name, required, values, aliases, coerceDefault, normalize, defaultValue);
        }

        // --- Nested object (single or array) --------------------------------
        if (field.SubType == FIELD_SUBTYPE_OBJECT || field.ObjectRef is not null)
        {
            MetaObject? referenced = ResolveObjectRef(field);
            bool cyclicOrDeep = referenced is null || visited.Contains(referenced) || depth + 1 >= MAX_NEST_DEPTH;
            if (cyclicOrDeep)
                return FieldSpec.Scalar(name, FieldKind.String, required);   // opaque leaf
            ExtractSchema nested = ExtractSchemaFor(referenced!, format, visited, depth + 1);
            return FieldSpec.Object(name, required, IsArrayType(field), nested);
        }

        // --- Scalar (single or array; carry generalized @default) -----------
        FieldKind kind = ScalarKind(field.SubType);
        string? scalarDefault = OwnAttrString(field, FIELD_ATTR_DEFAULT);
        // A scalar ARRAY (e.g. field.string isArray) must carry Array=true so the engine reads a
        // list (else a JSON array under a scalar key fails to coerce and the field is lost). The
        // engine's f.Array branch handles non-enum scalar arrays (raw element list). @default is a
        // single-value absent-fill and does not apply to the array element list, so it is dropped here.
        if (IsArrayType(field))
            return FieldSpec.ScalarArray(name, kind, required);
        return FieldSpec.Scalar(name, kind, required, scalarDefault);
    }

    // =========================================================================
    // Assemble — extracted Dictionary/List tree -> object graph
    // =========================================================================

    /// <summary>
    /// Assemble a extracted forgiving tree into a populated object graph described by
    /// <paramref name="mo"/>. <c>mo.NewInstance()</c> yields the bound type (or a
    /// <see cref="ValueObject"/>) with the back-ref already set; each field's value is written
    /// via the <see cref="MetaField"/> SPI. Cycle/depth-guarded identically to
    /// <see cref="ExtractSchemaFor(MetaObject, Format)"/>. Reflection-free; never throws on
    /// lost/malformed data (those were classified in the report during the engine pass).
    /// </summary>
    public static object Assemble(MetaObject mo, IReadOnlyDictionary<string, object?> data) =>
        Assemble(mo, data, NewVisited(), 0);

    private static object Assemble(MetaObject mo, IReadOnlyDictionary<string, object?>? data,
        HashSet<MetaObject> visited, int depth)
    {
        object o = mo.NewInstance();
        if (data is null) return o;

        visited.Add(mo);
        foreach (MetaField field in mo.Fields())
        {
            string name = field.Name;
            data.TryGetValue(name, out object? value);

            bool isObjectField = field.SubType == FIELD_SUBTYPE_OBJECT || field.ObjectRef is not null;
            // Enum fields are string-backed scalars/arrays — treat them as scalar assignment.
            if (!isObjectField || field.SubType == FIELD_SUBTYPE_ENUM)
            {
                // scalar / enum / scalar-array / enum-array: engine already coerced it.
                if (value is not null)
                    field.SetValue(o, value);
                continue;
            }

            // Nested object — guard cycles/depth (mirror the schema guard).
            MetaObject? referenced = ResolveObjectRef(field);
            bool cyclicOrDeep = referenced is null || visited.Contains(referenced) || depth + 1 >= MAX_NEST_DEPTH;

            if (IsArrayType(field))
            {
                // Array-of-objects: map each element Dictionary -> assembled child.
                if (value is IReadOnlyList<object?> elems)
                {
                    var children = new List<object>(elems.Count);
                    foreach (object? elem in elems)
                        if (elem is IReadOnlyDictionary<string, object?> childMap && !cyclicOrDeep)
                            children.Add(Assemble(referenced!, childMap, visited, depth + 1));
                    field.SetValue(o, children);
                }
                // absent array stays absent (the engine reports it).
            }
            else if (value is IReadOnlyDictionary<string, object?> childMap && !cyclicOrDeep)
            {
                object child = Assemble(referenced!, childMap, visited, depth + 1);
                field.SetValue(o, child);
            }
            // else leave null.
        }
        visited.Remove(mo);
        return o;
    }

    // =========================================================================
    // Enum-attr reading (mirrors ExtractSchemaEmitter / Fr010FieldMapping)
    // =========================================================================

    private static IReadOnlyList<string> EnumValues(MetaField field) =>
        field.EffectiveEnumValues ?? new List<string>();

    private static IReadOnlyDictionary<string, string> EnumAliases(MetaField field)
    {
        if (field.OwnAttr(FIELD_ATTR_ENUM_ALIAS) is not IReadOnlyDictionary<string, object?> d)
            return new Dictionary<string, string>();
        var aliases = new Dictionary<string, string>(System.StringComparer.Ordinal);
        foreach (var kv in d)
            if (kv.Value is not null)
                aliases[kv.Key] = kv.Value.ToString()!;
        return aliases;
    }

    /// <summary>
    /// Resolve the enum normalization mode: field-level <c>@normalize</c>, else the owning
    /// object's <c>@normalize</c>, else the global default ("strip").
    /// </summary>
    private static NormalizeMode ResolveNormalize(MetaField field, MetaObject owner)
    {
        string? fieldMode = OwnAttrString(field, FIELD_ATTR_NORMALIZE);
        if (fieldMode != null) return ParseNormalize(fieldMode);
        string? objMode = OwnAttrString(owner, FIELD_ATTR_NORMALIZE);
        if (objMode != null) return ParseNormalize(objMode);
        return NormalizeMode.Strip;
    }

    private static NormalizeMode ParseNormalize(string mode) => mode switch
    {
        "none" => NormalizeMode.None,
        "collapse" => NormalizeMode.Collapse,
        _ => NormalizeMode.Strip,
    };

    // =========================================================================
    // Common helpers
    // =========================================================================

    /// <summary>The own (non-inherited) string value of an attr on a node, or null when absent/empty.</summary>
    private static string? OwnAttrString(MetaData node, string attr) =>
        node.OwnAttr(attr) is string s && s.Length > 0 ? s : null;

    /// <summary>Map a scalar field subtype to its <see cref="FieldKind"/>. Unknown → STRING.</summary>
    private static FieldKind ScalarKind(string subType) => subType switch
    {
        FIELD_SUBTYPE_INT => FieldKind.Int,
        FIELD_SUBTYPE_LONG or FIELD_SUBTYPE_CURRENCY => FieldKind.Long,
        FIELD_SUBTYPE_DOUBLE or FIELD_SUBTYPE_FLOAT => FieldKind.Double,
        FIELD_SUBTYPE_DECIMAL => FieldKind.Decimal,
        FIELD_SUBTYPE_BOOLEAN => FieldKind.Boolean,
        _ => FieldKind.String,
    };

    private static bool IsArrayType(MetaField field) => field.IsArray;

    /// <summary>
    /// Resolve a field's <c>@objectRef</c> to its target <see cref="MetaObject"/> by matching the
    /// objectRef value against each object's <see cref="MetaData.ResolutionKey"/> (the canonical
    /// form an objectRef carries), falling back to a bare short-name match. Searches the whole
    /// tree from the root. Returns null when unresolved.
    /// </summary>
    private static MetaObject? ResolveObjectRef(MetaField field)
    {
        if (field.ObjectRef is not { } objectRef) return null;
        var root = field.Root();
        MetaObject? byKey = null;
        MetaObject? byName = null;
        string shortName = StripPkg(objectRef);
        foreach (MetaObject mo in DescendantObjects(root))
        {
            if (mo.ResolutionKey() == objectRef) { byKey = mo; break; }
            if (byName is null && mo.Name == shortName) byName = mo;
        }
        return byKey ?? byName;
    }

    /// <summary>Strip the package prefix from a resolution-key / objectRef value, leaving the short name.</summary>
    private static string StripPkg(string nameOrKey)
    {
        int idx = nameOrKey.LastIndexOf("::", System.StringComparison.Ordinal);
        return idx >= 0 ? nameOrKey[(idx + 2)..] : nameOrKey;
    }

    /// <summary>All <see cref="MetaObject"/> nodes in the tree rooted at <paramref name="node"/>.</summary>
    private static IEnumerable<MetaObject> DescendantObjects(MetaData node)
    {
        if (node is MetaObject mo) yield return mo;
        foreach (MetaData child in node.OwnChildren())
            foreach (MetaObject d in DescendantObjects(child))
                yield return d;
    }

    /// <summary>A fresh identity-based visited set for the cycle guard.</summary>
    private static HashSet<MetaObject> NewVisited() =>
        new(ReferenceEqualityComparer.Instance);
}
