// MetaTemplate — concrete node class for type=template nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/template/meta-template.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>template.*</c> nodes — the fourth-pillar metatype
/// (FR-004, R1): a renderable text artifact bound to a typed payload.
/// <para>
/// A single class backs both subtypes (<c>template.prompt</c>, <c>template.output</c>),
/// mirroring <see cref="MetaSource"/>: the loader dispatches by subtype and the
/// per-subtype attribute schemas (see <c>TemplateSchema</c>) drive validation.
/// Typed accessors are deferred to the render-engine / verify work — attr values
/// read generically via <c>OwnAttr(...)</c> until then, so no untested
/// forward-looking surface ships.
/// </para>
/// </summary>
public class MetaTemplate(TypeId typeId, string name) : MetaData(typeId, name);
