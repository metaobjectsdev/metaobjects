// Concrete node classes for the declared API surface (ADR-0030, ADR-0066): api.*,
// operation.* and binding.*. One class per type; the subtype carries no behaviour.
//
// Mirrors server/typescript/packages/metadata/src/core/api/meta-api.ts.

namespace MetaObjects.Meta;

/// <summary>Concrete node class for <c>api.*</c> nodes.</summary>
public class MetaApi(TypeId typeId, string name) : MetaData(typeId, name)
{
}

/// <summary>Concrete node class for <c>operation.*</c> nodes.</summary>
public class MetaOperation(TypeId typeId, string name) : MetaData(typeId, name)
{
}

/// <summary>Concrete node class for <c>binding.*</c> nodes.</summary>
public class MetaBinding(TypeId typeId, string name) : MetaData(typeId, name)
{
}
