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
    // Java int range — used for distinguishing int vs long attr subtypes.
    private const long JavaIntMax =  2_147_483_647L;
    private const long JavaIntMin = -2_147_483_648L;

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
        var nodeObj = SerializeNode(model, inlineAttrs: true, effective: false);
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
        var nodeObj = SerializeNode(model, inlineAttrs: true, effective: true);
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
    // Infer attr subType from a runtime AttrValue (for child-node form)
    // ---------------------------------------------------------------------------

    private static string InferAttrSubType(object? value)
    {
        return value switch
        {
            IReadOnlyList<string> => Constants.ATTR_SUBTYPE_STRINGARRAY,
            bool => Constants.ATTR_SUBTYPE_BOOLEAN,
            long l => (l >= JavaIntMin && l <= JavaIntMax)
                ? Constants.ATTR_SUBTYPE_INT
                : Constants.ATTR_SUBTYPE_LONG,
            double d => Number.IsIntegerDouble(d)
                ? ((long)d >= JavaIntMin && (long)d <= JavaIntMax
                    ? Constants.ATTR_SUBTYPE_INT
                    : Constants.ATTR_SUBTYPE_LONG)
                : Constants.ATTR_SUBTYPE_DOUBLE,
            _ => Constants.ATTR_SUBTYPE_STRING,
        };
    }

    // ---------------------------------------------------------------------------
    // Build the fused "type.subType" wrapper key
    // ---------------------------------------------------------------------------

    private static string FusedKey(string type, string subType)
        => $"{type}{Constants.TYPE_SUBTYPE_SEPARATOR}{subType}";

    // ---------------------------------------------------------------------------
    // Serialize a single node → { "<type>.<subType>": { ...body } }
    // ---------------------------------------------------------------------------

    private static JsonObject SerializeNode(MetaData model, bool inlineAttrs, bool effective)
    {
        var inner = SerializeNodeInner(model, inlineAttrs, effective);
        var wrapper = new JsonObject();
        wrapper.Add(FusedKey(model.Type, model.SubType), inner);
        return wrapper;
    }

    private static JsonObject SerializeNodeInner(MetaData model, bool inlineAttrs, bool effective)
    {
        // Canonical body-key order:
        //   1. name  2. package  3. extends  4. abstract
        //   5. overlay  (deliberately NOT emitted)  6. isArray
        //   7. inline @-attrs  8. children

        var obj = new JsonObject();

        if (model.Name != "")
        {
            obj.Add(Constants.RESERVED_KEY_NAME, JsonValue.Create(model.Name));
        }

        if (model.Package is not null && model.Package != "")
        {
            obj.Add(Constants.RESERVED_KEY_PACKAGE, JsonValue.Create(model.Package));
        }

        if (model.SuperRef is not null)
        {
            obj.Add(Constants.RESERVED_KEY_EXTENDS, JsonValue.Create(model.SuperRef));
        }

        if (model.IsAbstract)
        {
            obj.Add(Constants.RESERVED_KEY_ABSTRACT, JsonValue.Create(true));
        }

        // NOTE: overlay is NOT serialized (authoring-time directive only).

        if (model.IsArray)
        {
            obj.Add(Constants.RESERVED_KEY_IS_ARRAY, JsonValue.Create(true));
        }

        // In effective mode use Children()/Attrs() (own + inherited via super chain);
        // in own mode use OwnChildren()/OwnAttrs() (declared on this node only).
        var childList = effective ? model.Children() : model.OwnChildren();
        var attrMap = effective ? model.Attrs() : model.OwnAttrs();

        // Walk children: structural children recurse; attr children emit either as
        // inline @-attrs or as child {"attr.*": {...}} nodes.
        var emittedAsChild = new HashSet<string>(StringComparer.Ordinal);
        var serializedChildren = new JsonArray();

        foreach (var child in childList)
        {
            if (child.Type != Constants.TYPE_ATTR)
            {
                serializedChildren.Add(SerializeNode(child, inlineAttrs, effective));
                continue;
            }

            // Emit attr as child node form
            var attrName = child.Name;
            var attrValue = child.OwnAttr(Constants.RESERVED_KEY_VALUE);
            var attrSubType = child.SubType != Constants.SUBTYPE_BASE
                ? child.SubType
                : InferAttrSubType(attrValue ?? "");

            var attrBody = new JsonObject
            {
                { Constants.RESERVED_KEY_NAME, JsonValue.Create(attrName) },
                { Constants.RESERVED_KEY_VALUE, AttrValueToJsonNode(attrValue) },
            };
            var attrWrapper = new JsonObject();
            attrWrapper.Add(FusedKey(Constants.TYPE_ATTR, attrSubType), attrBody);
            serializedChildren.Add(attrWrapper);
            emittedAsChild.Add(attrName);
        }

        // Inline @-attrs: emit attrs NOT already emitted as child nodes.
        foreach (var (attrName, attrValue) in attrMap)
        {
            if (emittedAsChild.Contains(attrName)) continue;

            if (inlineAttrs)
            {
                obj.Add($"{Constants.ATTR_PREFIX}{attrName}", AttrValueToJsonNode(attrValue));
            }
            else
            {
                var subType = InferAttrSubType(attrValue);
                var attrBody = new JsonObject
                {
                    { Constants.RESERVED_KEY_NAME, JsonValue.Create(attrName) },
                    { Constants.RESERVED_KEY_VALUE, AttrValueToJsonNode(attrValue) },
                };
                var attrWrapper = new JsonObject();
                attrWrapper.Add(FusedKey(Constants.TYPE_ATTR, subType), attrBody);
                serializedChildren.Add(attrWrapper);
            }
        }

        // children — emit only if non-empty
        if (serializedChildren.Count > 0)
        {
            obj.Add(Constants.RESERVED_KEY_CHILDREN, serializedChildren);
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
        var jsonObj = new JsonObject();
        foreach (var (key, val) in obj)
        {
            jsonObj.Add(key, AttrValueToJsonNode(val));
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
                if (kvp.Key.StartsWith(Constants.ATTR_PREFIX, StringComparison.Ordinal))
                    attrKeys.Add(kvp.Key);
                else
                    structuralKeys.Add(kvp.Key);
            }

            attrKeys.Sort(StringComparer.Ordinal);

            var result = new JsonObject();
            bool hasChildren = structuralKeys.Contains(Constants.RESERVED_KEY_CHILDREN);

            // Structural keys first (excluding children), preserving insertion order
            foreach (var k in structuralKeys)
            {
                if (k == Constants.RESERVED_KEY_CHILDREN) continue;
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
                result.Add(Constants.RESERVED_KEY_CHILDREN,
                    SortAttrKeys(obj[Constants.RESERVED_KEY_CHILDREN]?.DeepClone()));
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
