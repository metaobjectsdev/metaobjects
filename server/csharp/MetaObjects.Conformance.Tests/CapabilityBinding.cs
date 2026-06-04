// CapabilityBinding.cs — port of typescript/packages/metadata/test/conformance/binding.ts.
//
// Capability dispatch table: maps capability-id strings to functions that
// invoke typed-tree accessors on a node and normalize the result.

using MetaObjects.Meta;
using MetaObjects.Core.Query;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Thrown when an unknown capability-id is requested.
/// Ports <c>UnknownCapabilityError</c> from typescript/packages/conformance/src/adapter.ts.
/// </summary>
public sealed class UnknownCapabilityException(string capabilityId)
    : Exception($"No binding for capability '{capabilityId}'")
{
    public string CapabilityId { get; } = capabilityId;
}

/// <summary>
/// Dispatch table: capability-id → normalizer function.
/// </summary>
public static class CapabilityBinding
{
    private delegate NormalizedResult CapabilityFn(
        MetaData node, IReadOnlyDictionary<string, object?> args);

    private static readonly IReadOnlyDictionary<string, CapabilityFn> Bindings =
        new Dictionary<string, CapabilityFn>(StringComparer.Ordinal)
        {
            // object.effective-fields → MetaObject.Fields() (own + inherited via extends)
            ["object.effective-fields"] = (node, _) =>
                NormalizedResult.Names(AsObject(node).Fields().Select(f => f.Name).ToList()),

            // object.own-fields → MetaObject.OwnFields() (excludes inherited)
            ["object.own-fields"] = (node, _) =>
                NormalizedResult.Names(AsObject(node).OwnFields().Select(f => f.Name).ToList()),

            // object.find-field → MetaObject.FindField(name); a miss → { absent: true }
            ["object.find-field"] = (node, args) =>
            {
                var found = AsObject(node).FindField(StringArg(args, "name"));
                return found is null ? NormalizedResult.Absent() : NormalizedResult.Name(found.Name);
            },

            // object.primary-identity → MetaObject.PrimaryIdentity(); subtype or absent
            ["object.primary-identity"] = (node, _) =>
            {
                var id = AsObject(node).PrimaryIdentity();
                return id is null ? NormalizedResult.Absent() : NormalizedResult.Subtype(id.SubType);
            },

            // field.effective-validators → MetaField.Validators() (own + inherited)
            ["field.effective-validators"] = (node, _) =>
                NormalizedResult.Names(AsField(node).Validators().Select(v => v.Name).ToList()),

            // field.is-required → MetaField.IsRequired (property)
            ["field.is-required"] = (node, _) =>
                NormalizedResult.Scalar(AsField(node).IsRequired),

            // field.max-length → MetaField.MaxLength (property); null → absent
            ["field.max-length"] = (node, _) =>
            {
                var len = AsField(node).MaxLength;
                return len is null ? NormalizedResult.Absent() : NormalizedResult.Scalar(len.Value);
            },

            // field.effective-tree → canonical serialization of the node subtree
            ["field.effective-tree"] = (node, _) =>
                NormalizedResult.EffectiveTree(MetaObjects.SerializerJson.CanonicalSerialize(AsField(node))),

            // field.filter-ops → the canonical per-subtype filter-operator band
            // (QueryConstants.OPS_BY_SUBTYPE). Returns { names: [...] } in canonical
            // operator order. Single source of truth — the same map the server
            // allowlist + codegen consume.
            ["field.filter-ops"] = (node, _) =>
                NormalizedResult.Names(QueryConstants.OpsForSubType(AsField(node).SubType).ToList()),
        };

    /// <summary>
    /// Invoke a capability on a node and return the normalized result.
    /// Throws <see cref="UnknownCapabilityException"/> if the capability-id is not bound.
    /// </summary>
    public static NormalizedResult Invoke(
        MetaData node,
        string capabilityId,
        IReadOnlyDictionary<string, object?> args)
    {
        if (!Bindings.TryGetValue(capabilityId, out var fn))
            throw new UnknownCapabilityException(capabilityId);
        return fn(node, args);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static MetaObject AsObject(MetaData node)
    {
        if (node is not MetaObject obj)
            throw new InvalidOperationException(
                $"expected an object node, got type='{node.Type}'");
        return obj;
    }

    private static MetaField AsField(MetaData node)
    {
        if (node is not MetaField field)
            throw new InvalidOperationException(
                $"expected a field node, got type='{node.Type}'");
        return field;
    }

    private static string StringArg(IReadOnlyDictionary<string, object?> args, string key)
    {
        if (!args.TryGetValue(key, out var val) || val is not string s)
            throw new InvalidOperationException(
                $"capability arg \"{key}\" must be a string");
        return s;
    }
}
