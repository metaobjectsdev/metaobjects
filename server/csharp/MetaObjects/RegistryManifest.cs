// SP-G Registry Conformance — the C# registry-manifest emitter.
//
// Walks an assembled TypeRegistry and serializes the LOGICAL metamodel
// vocabulary as a canonical, fully-sorted, byte-stable JSON manifest. This must
// byte-match the single committed canonical produced by the TS reference
// emitter (server/typescript/packages/metadata/src/registry-manifest.ts) — a
// structural gate against the SP-C class of silent vocabulary drift.
//
// The IN/OUT boundary (the v1 logical subset emittable byte-identically by all
// five ports) is documented in fixtures/registry-conformance/README.md. In
// short: type.subType + attrs[{name, valueType, required}] + commonAttrs +
// defaultSubTypes. EXCLUDED from v1 (per-port-physical or not-universally-
// tracked-on-the-registry): factories/native bindings; AttrSchema.Default and
// AllowedValues; declared parent (inheritsFrom); childRules.

using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace MetaObjects;

/// <summary>
/// Emits the canonical registry manifest (the SP-G cross-port logical-vocabulary
/// contract) as a byte-stable JSON string. Mirrors the TS reference emitter
/// <c>emitRegistryManifest</c> exactly.
/// </summary>
public static class RegistryManifest
{
    // ------------------------------------------------------------------
    // Manifest shape — explicit ordered structures so JSON property order is
    // fixed by construction (insertion order), never reflection-dependent.
    // ------------------------------------------------------------------

    /// <summary>One attribute in the manifest — the logical, cross-port-identical facet.</summary>
    private sealed record ManifestAttr(string Name, string? ValueType, bool Required);

    /// <summary>One registered (type, subType) with its declared attrs.</summary>
    private sealed record ManifestType(string Type, string SubType, IReadOnlyList<ManifestAttr> Attrs);

    // ------------------------------------------------------------------
    // Build
    // ------------------------------------------------------------------

    /// <summary>
    /// Build the canonical manifest as ordered, sorted collections.
    /// All collections are sorted by ordinal (locale-independent) string compare
    /// for byte-stability across ports.
    /// </summary>
    private static (List<ManifestType> Types, List<ManifestAttr> CommonAttrs, SortedDictionary<string, string> DefaultSubTypes)
        Build(TypeRegistry registry)
    {
        List<ManifestType> types = registry
            .AllTypes()
            .Select(typeId => new ManifestType(
                typeId.Type,
                typeId.SubType,
                SortedAttrs(registry.AttrsOf(typeId.Type, typeId.SubType))))
            .OrderBy(t => $"{t.Type}.{t.SubType}", StringComparer.Ordinal)
            .ToList();

        List<ManifestAttr> commonAttrs = SortedAttrs(registry.GetCommonAttrs());

        // defaultSubTypes: derive candidate type names from the registered types,
        // probe each, and key into a SortedDictionary (ordinal) for stable order.
        SortedDictionary<string, string> defaultSubTypes = new(StringComparer.Ordinal);
        foreach (string typeName in types.Select(t => t.Type).Distinct())
        {
            string? defaultSub = registry.DefaultSubTypeOf(typeName);
            if (defaultSub is not null)
            {
                defaultSubTypes[typeName] = defaultSub;
            }
        }

        return (types, commonAttrs, defaultSubTypes);
    }

    /// <summary>Normalize + sort attr schemas to the manifest's logical attr shape (by name, ordinal).</summary>
    private static List<ManifestAttr> SortedAttrs(IReadOnlyList<AttrSchema> attrs) =>
        attrs
            .Select(a => new ManifestAttr(a.Name, a.ValueType, a.Required))
            .OrderBy(a => a.Name, StringComparer.Ordinal)
            .ToList();

    // ------------------------------------------------------------------
    // Emit
    // ------------------------------------------------------------------

    /// <summary>
    /// Emit the canonical registry manifest as a byte-stable JSON string.
    ///
    /// Serialization contract — every port MUST match this exactly:
    ///  - 2-space indentation.
    ///  - Object key order fixed by construction: <c>types</c>, <c>commonAttrs</c>,
    ///    <c>defaultSubTypes</c>; each type as <c>type</c>, <c>subType</c>, <c>attrs</c>;
    ///    each attr as <c>name</c>, <c>valueType</c>, <c>required</c>.
    ///  - All arrays sorted (ordinal/ASCII): types by "type.subType"; attrs by name;
    ///    commonAttrs by name; defaultSubTypes keys sorted.
    ///  - <c>valueType: null</c> literal for polymorphic/untyped attrs.
    ///  - A single trailing newline.
    /// </summary>
    public static string Emit(TypeRegistry registry)
    {
        (List<ManifestType> types, List<ManifestAttr> commonAttrs, SortedDictionary<string, string> defaultSubTypes) =
            Build(registry);

        // Hand-roll via Utf8JsonWriter against an ordered model so property order
        // is guaranteed and never reflection/anonymous-type dependent.
        using var stream = new MemoryStream();
        var writerOptions = new JsonWriterOptions
        {
            Indented = true,
            // Match plain JSON: do not \uXXXX-escape '+', '&', '<', '>' etc. so
            // the bytes line up with the TS JSON.stringify reference output.
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        using (var writer = new Utf8JsonWriter(stream, writerOptions))
        {
            writer.WriteStartObject();

            // types
            writer.WriteStartArray("types");
            foreach (ManifestType t in types)
            {
                writer.WriteStartObject();
                writer.WriteString("type", t.Type);
                writer.WriteString("subType", t.SubType);
                writer.WriteStartArray("attrs");
                foreach (ManifestAttr a in t.Attrs)
                {
                    WriteAttr(writer, a);
                }
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
            writer.WriteEndArray();

            // commonAttrs
            writer.WriteStartArray("commonAttrs");
            foreach (ManifestAttr a in commonAttrs)
            {
                WriteAttr(writer, a);
            }
            writer.WriteEndArray();

            // defaultSubTypes
            writer.WriteStartObject("defaultSubTypes");
            foreach (KeyValuePair<string, string> kv in defaultSubTypes)
            {
                writer.WriteString(kv.Key, kv.Value);
            }
            writer.WriteEndObject();

            writer.WriteEndObject();
        }

        string json = Encoding.UTF8.GetString(stream.ToArray());
        // Utf8JsonWriter indents with 2 spaces and "\n" newlines (no trailing
        // newline). Append the single trailing newline the canonical carries.
        return json + "\n";
    }

    private static void WriteAttr(Utf8JsonWriter writer, ManifestAttr a)
    {
        writer.WriteStartObject();
        writer.WriteString("name", a.Name);
        if (a.ValueType is null)
        {
            writer.WriteNull("valueType");
        }
        else
        {
            writer.WriteString("valueType", a.ValueType);
        }
        writer.WriteBoolean("required", a.Required);
        writer.WriteEndObject();
    }
}
