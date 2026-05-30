// Canonical JSON serializer — ported from typescript/packages/metadata/src/serializer-json.ts.
//
// Every node serializes to a single-key map { "<type>.<subType>": <body> }.
// The body emits keys in the canonical order, each included only when non-default:
//   1. name      2. package   3. extends   4. abstract
//   5. overlay   (NOT emitted — authoring-time directive, not present on resolved tree)
//   6. isArray   7. @-attrs (alphabetical)   8. children

using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.Meta;

namespace MetaObjects;

/// <summary>
/// Canonical JSON serializer. Produces byte-identical output to the TypeScript
/// <c>canonicalSerialize</c> / <c>canonicalSerializeEffective</c> functions.
/// </summary>
public static class SerializerJson
{
    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Serialize <paramref name="model"/> using its own (declared) attrs and children.
    /// Output is deterministic: attrs sorted alphabetically, trailing LF.
    /// Byte-identical to the TypeScript <c>canonicalSerialize</c>.
    /// </summary>
    public static string CanonicalSerialize(MetaData model)
    {
        var nodeObj = SerializeNode(model, effective: false);
        var sorted = SortAttrKeys(nodeObj)!;
        return Stringify(sorted) + "\n";
    }

    /// <summary>
    /// Like <see cref="CanonicalSerialize"/>, but emits the EFFECTIVE tree —
    /// <c>Children()</c> and <c>Attrs()</c> at every node (own + inherited via
    /// the super chain). Used by the conformance harness's expected-effective fixtures.
    /// Byte-identical to the TypeScript <c>canonicalSerializeEffective</c>.
    /// </summary>
    public static string CanonicalSerializeEffective(MetaData model)
    {
        var nodeObj = SerializeNode(model, effective: true);
        var sorted = SortAttrKeys(nodeObj)!;
        return Stringify(sorted) + "\n";
    }

    // ---------------------------------------------------------------------------
    // JSON output settings
    // ---------------------------------------------------------------------------

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        // JSON.stringify does NOT escape <, >, &, ', + etc. Match that behavior.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static string Stringify(JsonNode node)
    {
        return node.ToJsonString(JsonOpts);
    }

    // ---------------------------------------------------------------------------
    // Build the fused "type.subType" wrapper key
    // ---------------------------------------------------------------------------

    private static string FusedKey(string type, string subType)
        => $"{type}{TYPE_SUBTYPE_SEPARATOR}{subType}";

    // ---------------------------------------------------------------------------
    // Serialize a single node → { "<type>.<subType>": { ...body } }
    // ---------------------------------------------------------------------------

    private static JsonObject SerializeNode(MetaData model, bool effective)
    {
        var inner = SerializeNodeInner(model, effective);
        var wrapper = new JsonObject();
        wrapper.Add(FusedKey(model.Type, model.SubType), inner);
        return wrapper;
    }

    private static JsonObject SerializeNodeInner(MetaData model, bool effective)
    {
        // Canonical body-key order:
        //   1. name  2. package  3. extends  4. abstract
        //   5. overlay  (deliberately NOT emitted)  6. isArray
        //   7. inline @-attrs  8. children

        var obj = new JsonObject();

        if (model.Name != "")
        {
            obj.Add(RESERVED_KEY_NAME, JsonValue.Create(model.Name));
        }

        if (model.Package is not null && model.Package != "")
        {
            obj.Add(RESERVED_KEY_PACKAGE, JsonValue.Create(model.Package));
        }

        if (model.SuperRef is not null)
        {
            obj.Add(RESERVED_KEY_EXTENDS, JsonValue.Create(model.SuperRef));
        }

        if (model.IsAbstract)
        {
            obj.Add(RESERVED_KEY_ABSTRACT, JsonValue.Create(true));
        }

        // NOTE: overlay is NOT serialized (authoring-time directive only).

        if (model.IsArray)
        {
            obj.Add(RESERVED_KEY_IS_ARRAY, JsonValue.Create(true));
        }

        // In effective mode use Children()/Attrs() (own + inherited via super chain);
        // in own mode use OwnChildren()/OwnAttrs() (declared on this node only).
        var childList = effective ? model.Children() : model.OwnChildren();
        var attrMap = effective ? model.Attrs() : model.OwnAttrs();

        // Walk children: structural children recurse. Attrs are ALWAYS emitted
        // inline as @-attrs (never as child {"attr.*": {...}} nodes), so attr-typed
        // children are skipped here — the C# parser dual-stores each attr both as a
        // child node and as a parent attr (Parser.cs:950-951), and the inline loop
        // below emits it from attrMap.
        var serializedChildren = new JsonArray();

        foreach (var child in childList)
        {
            if (child.Type == TYPE_ATTR) continue;
            serializedChildren.Add(SerializeNode(child, effective));
        }

        // Inline @-attrs — always emitted as @name; attrs have no child form.
        foreach (var (attrName, attrValue) in attrMap)
        {
            obj.Add($"{ATTR_PREFIX}{attrName}", AttrValueToJsonNode(attrValue));
        }

        // children — emit only if non-empty
        if (serializedChildren.Count > 0)
        {
            obj.Add(RESERVED_KEY_CHILDREN, serializedChildren);
        }

        return obj;
    }

    // ---------------------------------------------------------------------------
    // Convert an AttrValue (object?) to a JsonNode
    // ---------------------------------------------------------------------------

    private static JsonNode? AttrValueToJsonNode(object? value)
    {
        return value switch
        {
            null => null,
            string s => JsonValue.Create(s),
            bool b => JsonValue.Create(b),
            long l => JsonValue.Create(l),
            double d => Number.IsIntegerDouble(d)
                // Whole-number doubles: emit as long so JSON.stringify parity (no ".0")
                ? JsonValue.Create((long)d)
                : JsonValue.Create(d),
            IReadOnlyList<string> arr =>
                new JsonArray(arr.Select(s => (JsonNode?)JsonValue.Create(s)).ToArray()),
            IReadOnlyDictionary<string, object?> obj =>
                AttrObjectToJsonNode(obj),
            IReadOnlyList<object?> arr =>
                new JsonArray(arr.Select(item => AttrValueToJsonNode(item)).ToArray()),
            _ => JsonValue.Create(value?.ToString()),
        };
    }

    private static JsonObject AttrObjectToJsonNode(IReadOnlyDictionary<string, object?> obj)
    {
        // The two object-typed attr subtypes need different key order in canonical form,
        // and the serializer is schema-free — so distinguish by value shape, which exactly
        // tracks the subtypes:
        //   • `properties` (e.g. @enumDoc / @enumAlias) is a flat scalar→scalar map → keys
        //     sort ordinally (cross-port canonical form; matches the Java reference, whose
        //     Properties is unordered and serializes sorted).
        //   • `filter` maps a field to an operator object ({eq:…}/{in:[…]}) — at least one
        //     value is itself an object/array → declaration order is preserved (significant).
        bool allScalar = obj.Values.All(v =>
            v is null or string or bool or long or int or double or float);
        var keys = allScalar ? obj.Keys.OrderBy(k => k, StringComparer.Ordinal) : obj.Keys;

        var jsonObj = new JsonObject();
        foreach (var key in keys)
        {
            jsonObj.Add(key, AttrValueToJsonNode(obj[key]));
        }
        return jsonObj;
    }

    // ---------------------------------------------------------------------------
    // SortAttrKeys — recursively reorders object keys so @-attrs are alphabetical
    // and structural keys keep the canonical documented order, with children last.
    // Mirrors the TS sortAttrKeys function.
    // ---------------------------------------------------------------------------

    private static JsonNode? SortAttrKeys(JsonNode? node)
    {
        if (node is JsonArray arr)
        {
            var sorted = new JsonArray();
            foreach (var item in arr)
            {
                sorted.Add(SortAttrKeys(item?.DeepClone()));
            }
            return sorted;
        }

        if (node is JsonObject obj)
        {
            var structuralKeys = new List<string>();
            var attrKeys = new List<string>();

            foreach (var kvp in obj)
            {
                if (kvp.Key.StartsWith(ATTR_PREFIX, StringComparison.Ordinal))
                    attrKeys.Add(kvp.Key);
                else
                    structuralKeys.Add(kvp.Key);
            }

            attrKeys.Sort(StringComparer.Ordinal);

            var result = new JsonObject();
            bool hasChildren = structuralKeys.Contains(RESERVED_KEY_CHILDREN);

            // Structural keys first (excluding children), preserving insertion order
            foreach (var k in structuralKeys)
            {
                if (k == RESERVED_KEY_CHILDREN) continue;
                result.Add(k, SortAttrKeys(obj[k]?.DeepClone()));
            }

            // @-attrs alphabetically
            foreach (var k in attrKeys)
            {
                result.Add(k, SortAttrKeys(obj[k]?.DeepClone()));
            }

            // children last
            if (hasChildren)
            {
                result.Add(RESERVED_KEY_CHILDREN,
                    SortAttrKeys(obj[RESERVED_KEY_CHILDREN]?.DeepClone()));
            }

            return result;
        }

        // Scalar — return as-is (clone for safety)
        return node?.DeepClone();
    }
}

// ---------------------------------------------------------------------------
// Internal helper: double classification
// ---------------------------------------------------------------------------

file static class Number
{
    /// <summary>
    /// True when <paramref name="d"/> is a whole number (integer value stored as double).
    /// Mirrors JavaScript's Number.isInteger().
    /// </summary>
    internal static bool IsIntegerDouble(double d)
        => !double.IsInfinity(d) && !double.IsNaN(d) && Math.Truncate(d) == d;
}
