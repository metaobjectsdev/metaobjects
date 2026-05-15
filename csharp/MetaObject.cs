namespace MetaObjects;

/// <summary>Concrete node — an object/entity. Exposes typed field accessors.</summary>
public class MetaObject : MetaData
{
    public MetaObject(string subType, string name) : base("object", subType, name) { }

    /// <summary>Effective fields — own + super-chain-inherited.</summary>
    public IReadOnlyList<MetaField> Fields() =>
        Cached("fields", () =>
            (IReadOnlyList<MetaField>)EffectiveChildren().OfType<MetaField>().ToList());

    /// <summary>Own fields only — excludes inherited.</summary>
    public IReadOnlyList<MetaField> OwnFields() =>
        Children().OfType<MetaField>().ToList();
}
