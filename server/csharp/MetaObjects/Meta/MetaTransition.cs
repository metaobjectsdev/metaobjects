// Concrete node class for transition.* nodes (ADR-0063). Mirrors
// server/typescript/packages/metadata/src/core/transition/meta-transition.ts.

namespace MetaObjects.Meta;

/// <summary>Concrete node class for <c>transition.*</c> nodes.</summary>
public class MetaTransition(TypeId typeId, string name) : MetaData(typeId, name)
{
}
