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
using MetaObjects.Persistence.Source;

namespace MetaObjects;

/// <summary>
/// How references are written (ADR-0059 R8).
/// <see cref="Canonical"/> (default): each reference as the loader resolved it (<c>pkg::Name</c>,
/// <c>::Name</c> for a root-level target from a packaged referrer) and the document package rule;
/// the output loads back to the same model from any source. <see cref="Authored"/>: each reference,
/// <c>extends</c> included, exactly as written, and every <c>package</c> where it was written. Only
/// <c>fmt</c> uses it, so formatting never rewrites what an author wrote.
/// </summary>
public enum RefSpelling { Canonical, Authored }

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
    public static string CanonicalSerialize(MetaData model, RefSpelling refs = RefSpelling.Canonical)
    {
        var nodeObj = SerializeNode(model, effective: false, refs, null);
        // FR-016 / ADR-0018: rewrite legacy @table → kind-matching alias on
        // source.rdb wrappers (run before alphabetical sort so the rewritten
        // key sorts in its canonical position).
        RewriteSourceRdbPhysicalNames(nodeObj);
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
        var nodeObj = SerializeNode(model, effective: true, RefSpelling.Canonical, null);
        RewriteSourceRdbPhysicalNames(nodeObj);
        var sorted = SortAttrKeys(nodeObj)!;
        return Stringify(sorted) + "\n";
    }

    /// <summary>
    /// The FR-023 shared-model artifact: one canonical-JSON <c>metadata.root</c> holding the given
    /// top-level nodes, from any number of packages. The document has NO root <c>package</c>, and every
    /// node carries its own explicit, RESOLVED <c>package</c> (a root-level child may name its package,
    /// ADR-0029's addressing model), so the artifact re-loads to the same resolution keys in every port.
    /// Each node is its <see cref="CanonicalSerialize"/> form: raw own layer, <c>extends</c> preserved
    /// (never flattened), attribute keys alphabetized. Nodes are sorted by resolution key (ordinal);
    /// each node's children keep their authored order. Body key order: <c>name</c>, <c>package</c>,
    /// then the canonical rest. Byte-identical to the TypeScript <c>serializeSharedDocument</c>.
    /// </summary>
    /// <exception cref="InvalidOperationException">A node has no package: a shared document carries
    /// only packaged nodes.</exception>
    public static string SerializeSharedDocument(IEnumerable<MetaData> nodes)
    {
        var children = new JsonArray();
        foreach (var node in nodes.OrderBy(n => n.ResolutionKey(), StringComparer.Ordinal))
        {
            var key = node.ResolutionKey();
            var sep = key.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
            var pkg = sep == -1 ? "" : key[..sep];
            if (pkg.Length == 0)
                throw new InvalidOperationException(
                    $"SerializeSharedDocument: {key} has no package; a shared document carries only packaged nodes");

            var parsed = (JsonObject)JsonNode.Parse(CanonicalSerialize(node))!;
            var (fused, bodyNode) = parsed.Single();
            var body = (JsonObject)bodyNode!;
            // The node's own `package` (if it declared one) is replaced by the RESOLVED one: a node
            // inheriting its file's root package declares none of its own.
            var ordered = new JsonObject();
            var name = body[RESERVED_KEY_NAME];
            body.Remove(RESERVED_KEY_NAME);
            ordered.Add(RESERVED_KEY_NAME, name);
            body.Remove(RESERVED_KEY_PACKAGE);
            ordered.Add(RESERVED_KEY_PACKAGE, pkg);
            foreach (var (k, v) in body.ToList())
            {
                body.Remove(k);
                ordered.Add(k, v);
            }
            children.Add(new JsonObject { [fused] = ordered });
        }
        var doc = new JsonObject
        {
            [FusedKey(TYPE_METADATA, SUBTYPE_ROOT)] = new JsonObject { [RESERVED_KEY_CHILDREN] = children },
        };
        return Stringify(doc) + "\n";
    }

    // ---------------------------------------------------------------------------
    // FR-016 / ADR-0018 — per-kind physical-name rewrite (pre-sort).
    //
    // When a source.rdb wrapper carries @table with a non-table @kind (the
    // pre-1.0 legacy spelling), rewrite the attr key in place to the kind-
    // matching alias (@view / @materializedView / @proc / @function). Mutates
    // the JsonNode tree in place; idempotent and a no-op for canonical inputs.
    // ---------------------------------------------------------------------------

    private static readonly string SourceRdbFusedKey =
        $"{TYPE_SOURCE}{TYPE_SUBTYPE_SEPARATOR}{SourceConstants.SOURCE_SUBTYPE_RDB}";

    private static void RewriteSourceRdbPhysicalNames(JsonNode? node)
    {
        if (node is JsonArray arr)
        {
            foreach (var item in arr) RewriteSourceRdbPhysicalNames(item);
            return;
        }

        if (node is not JsonObject obj) return;

        if (obj.TryGetPropertyValue(SourceRdbFusedKey, out var rdbBody)
            && rdbBody is JsonObject body)
        {
            var kindKey = $"{ATTR_PREFIX}{SourceConstants.SOURCE_ATTR_KIND}";
            string kind = SourceConstants.DEFAULT_SOURCE_KIND;
            if (body.TryGetPropertyValue(kindKey, out var kindNode)
                && kindNode is JsonValue kv
                && kv.TryGetValue<string>(out var ks)
                && ks != "")
            {
                kind = ks;
            }

            if (SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND.TryGetValue(kind, out var canonical)
                && canonical != SourceConstants.SOURCE_ATTR_TABLE)
            {
                var legacyKey = $"{ATTR_PREFIX}{SourceConstants.SOURCE_ATTR_TABLE}";
                var canonicalKey = $"{ATTR_PREFIX}{canonical}";
                if (body.TryGetPropertyValue(legacyKey, out var legacyValue)
                    && !body.ContainsKey(canonicalKey))
                {
                    // Detach the legacy value from the parent so we can re-attach
                    // under the canonical key. JsonNode disallows shared ownership.
                    body.Remove(legacyKey);
                    body[canonicalKey] = legacyValue;
                }
            }
        }

        // Recurse through every value (in particular `children` arrays).
        foreach (var kvp in obj)
        {
            RewriteSourceRdbPhysicalNames(kvp.Value);
        }
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

    private static JsonObject SerializeNode(MetaData model, bool effective, RefSpelling refs, string? pkgSlot)
    {
        var inner = SerializeNodeInner(model, effective, refs, pkgSlot);
        var wrapper = new JsonObject();
        wrapper.Add(FusedKey(model.Type, model.SubType), inner);
        return wrapper;
    }

    /// <summary>Effective package of a top-level node (ADR-0059 R10): own, else its file's. A node
    /// built in code has no file, so it takes the root's package, as re-loading the output would.</summary>
    private static string TopLevelPackage(MetaData node, MetaData root) =>
        node.Package ?? node.FileDefaultPackage ?? root.Package ?? "";

    /// <summary>
    /// ADR-0059 R8 document package rule, for a <c>metadata.root</c> in canonical mode. Every named
    /// top-level node in one non-empty package P: the root carries P (a node keeps a package it
    /// carries itself). When the root states no package and every node names P itself, the root
    /// package stays absent. Otherwise no root package and each named top-level node carries its
    /// effective package. A root with no named top-level node keeps its own package.
    /// </summary>
    private static (string? RootPkg, bool PerNode) DocumentPackages(MetaData root)
    {
        // ADR-0039: own — the serializer writes the declared layer; the root has no super.
        var named = root.OwnChildren().Where(c => c.Name != "").ToList();
        if (named.Count == 0) return (root.Package, false);
        var pkgs = named.Select(c => TopLevelPackage(c, root)).Distinct().ToList();
        if (pkgs.Count == 1)
        {
            string only = pkgs[0];
            bool selfNamed = root.Package is null && named.All(c => c.Package == only);
            if (only != "") return (selfNamed ? null : only, false);
        }
        return (null, true);
    }

    private static JsonObject SerializeNodeInner(MetaData model, bool effective, RefSpelling refs, string? pkgSlot)
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

        bool isDocRoot = model.Type == TYPE_METADATA && model.SubType == SUBTYPE_ROOT;
        (string? RootPkg, bool PerNode)? doc = isDocRoot && refs == RefSpelling.Canonical ? DocumentPackages(model) : null;

        string? pkg = doc is not null ? doc.Value.RootPkg : pkgSlot ?? model.Package;
        if (!string.IsNullOrEmpty(pkg))
        {
            obj.Add(RESERVED_KEY_PACKAGE, JsonValue.Create(pkg));
        }

        // After the loader's ResolveReferences pass SuperRef is canonical (ADR-0059 R5); the
        // authored spelling is kept beside it for `fmt`.
        string? superRef = refs == RefSpelling.Authored ? model.AuthoredSuperRef ?? model.SuperRef : model.SuperRef;
        if (superRef is not null)
        {
            obj.Add(RESERVED_KEY_EXTENDS, JsonValue.Create(superRef));
        }

        if (model.IsAbstract)
        {
            obj.Add(RESERVED_KEY_ABSTRACT, JsonValue.Create(true));
        }

        // NOTE: overlay is NOT serialized (authoring-time directive only).

        // ADR-0039: effective mode resolves array-ness through the super chain (a
        // concrete field that extends an abstract array field is itself an array);
        // own mode (CanonicalSerialize) emits only the authored `isArray` so the
        // round-trip reconstructs the same extends tree.
        var isArrayForMode = effective ? model.ResolvedIsArray() : model.IsArray;
        if (isArrayForMode)
        {
            obj.Add(RESERVED_KEY_IS_ARRAY, JsonValue.Create(true));
        }

        // ADR-0039: the OwnChildren()/OwnAttrs() branch is the sanctioned own-mode canonical
        // serializer — it round-trips the AUTHORED form (declared-here only) so re-loading
        // reconstructs the same extends tree. Effective mode resolves via Children()/Attrs().
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
            // A top-level node's package follows the document rule; deeper nodes keep their own.
            // In a one-package document a node keeps any package it carries itself, so
            // single-package output is unchanged.
            string? childSlot = doc is not null && doc.Value.PerNode
                ? (child.Name != "" ? TopLevelPackage(child, model) : "")
                : null;
            serializedChildren.Add(SerializeNode(child, effective, refs, childSlot));
        }

        // Inline @-attrs — always emitted as @name; attrs have no child form.
        foreach (var (attrName, attrValue) in attrMap)
        {
            // ADR-0039: own — the authored value lives on the declaring node.
            object? shown = refs == RefSpelling.Authored && !effective ? model.OwnAuthoredAttr(attrName) : attrValue;
            obj.Add($"{ATTR_PREFIX}{attrName}", AttrValueToJsonNode(shown));
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
