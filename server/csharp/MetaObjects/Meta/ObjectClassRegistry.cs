// ObjectClassRegistry — resolution-key → factory binding for runtime instantiation.
//
// Idiomatic C# port of Java's ObjectClassRegistry / TS's ObjectClassRegistry:
// maps an object's package-folded resolution key (`package::name`) to a factory
// that produces a native backing instance.
//
// AOT-SAFE BY CONSTRUCTION: the registry stores and invokes a
// `Func<MetaObject, object>` constructor delegate — NEVER Type.GetType /
// Activator.CreateInstance(Type) / reflection (ADR-0001). Generated code (and
// tests) self-register a delegate that news-up the concrete type directly, so the
// typed lane is reflection-free and tree-shake / native-image safe.
//
// DISTINCT from the metadata TypeRegistry, which maps metamodel type/subType
// names to MetaData node classes. This registry maps a DATA object's resolution
// key to a runtime BACKING instance factory.

namespace MetaObjects.Meta;

/// <summary>Produces a native backing instance for the given <see cref="MetaObject"/>.</summary>
public delegate object ObjectFactory(MetaObject mo);

/// <summary>
/// Resolution-key (<c>package::name</c>) → backing-instance factory registry.
/// AOT-safe: invokes a stored constructor delegate, never reflection.
/// </summary>
public sealed class ObjectClassRegistry
{
    private readonly Dictionary<string, ObjectFactory> _factories = new(StringComparer.Ordinal);

    /// <summary>Bind a resolution key (<c>package::name</c>) to a backing-instance factory.</summary>
    public void Register(string fqn, ObjectFactory factory) => _factories[fqn] = factory;

    /// <summary>Resolve the factory bound to a resolution key, or <see langword="null"/> if none.</summary>
    public ObjectFactory? Resolve(string fqn) =>
        _factories.TryGetValue(fqn, out var f) ? f : null;

    /// <summary>True if a factory is bound to the resolution key.</summary>
    public bool Has(string fqn) => _factories.ContainsKey(fqn);

    /// <summary>Remove a binding (test/scoping convenience). Returns true if present.</summary>
    public bool Unregister(string fqn) => _factories.Remove(fqn);

    /// <summary>
    /// The process-level default registry. Generated code self-registers here at
    /// type-init time; <see cref="MetaObject.NewInstance"/> consults it when no
    /// explicit registry is passed. Tests should construct their own
    /// <see cref="ObjectClassRegistry"/> to avoid leaking bindings across cases.
    /// </summary>
    public static ObjectClassRegistry Default { get; } = new();
}
