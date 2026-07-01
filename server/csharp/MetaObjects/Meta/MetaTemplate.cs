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
/// Typed accessors are deferred to the render-engine / verify work — no untested
/// forward-looking surface ships. ADR-0039: consumers that need a template's effective
/// attr value read it via the RESOLVING <c>Attr(...)</c> accessor (a template may inherit
/// attrs from an abstract template base via <c>extends</c>).
/// </para>
/// </summary>
public class MetaTemplate(TypeId typeId, string name) : MetaData(typeId, name);
