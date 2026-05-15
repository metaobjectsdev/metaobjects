namespace MetaObjects;

/// <summary>Concrete node — a field.</summary>
public class MetaField : MetaData
{
    public MetaField(string subType, string name) : base("field", subType, name) { }

    /// <summary>Effective validators — own + super-chain-inherited.</summary>
    public IReadOnlyList<MetaData> Validators() =>
        Cached("validators", () =>
            (IReadOnlyList<MetaData>)EffectiveChildren().Where(c => c.Type == "validator").ToList());
}
