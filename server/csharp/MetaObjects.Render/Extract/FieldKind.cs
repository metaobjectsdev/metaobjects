// C# PascalCase enum members (String, Int, …).
// The conformance corpus schema.json uses "STRING"/"INT" etc. — the conformance
// runner maps those UPPER strings to these members.

namespace MetaObjects.Render.Extract;

/// <summary>The coercion target kinds the engine understands. Object = nested ExtractSchema.</summary>
public enum FieldKind
{
    String,
    Int,
    Long,
    Double,
    Decimal,
    Boolean,
    Enum,
    Object,
}
