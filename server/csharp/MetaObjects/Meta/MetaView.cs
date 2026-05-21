// MetaView — concrete node class for type=view nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-view.ts.
// Currently minimal — placeholder for v0.3+ view-level accessors.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>view.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
public class MetaView(TypeId typeId, string name) : MetaData(typeId, name) { }
