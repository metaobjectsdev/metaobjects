// IMetaObjectAware — the runtime back-reference contract.
//
// Idiomatic C# port of Java's MetaObjectAware / TS's MetaObjectAware: a backing
// object that knows the MetaObject describing it. The default backing type
// (ValueObject) implements this; generated/registered native types may implement
// it too so they carry a back-reference after NewInstance().
//
// Reflection-free — no Type.GetType, no Activator, no runtime type resolution.

namespace MetaObjects.Meta;

/// <summary>
/// A backing object that carries a reference to the <see cref="MetaObject"/>
/// describing it. Mirrors TS <c>MetaObjectAware</c> and Java <c>MetaObjectAware</c>.
/// </summary>
public interface IMetaObjectAware
{
    /// <summary>The MetaObject describing this instance, or <see langword="null"/> if not yet attached.</summary>
    MetaObject? GetMetaData();

    /// <summary>Attach the MetaObject describing this instance (back-reference).</summary>
    void SetMetaData(MetaObject mo);
}
