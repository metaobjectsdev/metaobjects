// ADR-0056 — the ONE answer, for every C# generator, to "what is this value object's type
// called, and in which namespace".
//
// A value object's C# type is emitted once, by EntityGenerator, as a POCO in the value object's
// own namespace (PackageBindingResolver). Every generator that names it — the entity tier's
// owned-type navigations, and the template tier's render helpers, parsers, extractors and api-docs
// — asks this class, so none of them can disagree with the declaration.
//
// Naming (ruling R52, amending ADR-0044 and ADR-0056): a value object's type is its own name,
// PascalCased, and is never rewritten. Two objects that share a short name in one namespace are a
// real collision, refused by the run's claim registry (GenContext.Claim) with the remedy: map the
// packages to distinct namespaces (GenConfig.PackageNamespaces), or rename one.

using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Object.ObjectConstants;

namespace MetaObjects.Codegen;

/// <summary>The emitted C# name and namespace of a value object's POCO (ADR-0056).</summary>
public static class ValueObjectNames
{
    /// <summary>True for a value-object shape: an <c>object.value</c>, or an <c>object.projection</c>
    /// with no <c>source.*</c> anywhere in its super chain (#210 — pure shape, like a value object).</summary>
    public static bool IsValueShape(MetaData obj) =>
        obj.Type == TYPE_OBJECT
        && (obj.SubType == OBJECT_SUBTYPE_VALUE
            || (obj.SubType == OBJECT_SUBTYPE_PROJECTION && !obj.Children().Any(c => c.Type == TYPE_SOURCE)));

    /// <summary>
    /// The emitted C# type name for <paramref name="obj"/>: its name, PascalCased. A value object is
    /// never renamed to avoid a collision (ruling R52). <paramref name="root"/> is unused, and kept
    /// so an owned generator copy calling it keeps compiling.
    /// </summary>
    public static string TypeName(MetaData obj, MetaData root) => CSharpNaming.Pascal(obj.Name);

    /// <summary>The namespace <paramref name="obj"/>'s type is emitted into (package binding).</summary>
    public static string Namespace(MetaData obj, GenConfig config) =>
        PackageBindingResolver.Resolve(
            config, PackageBindingResolver.EffectivePackage(obj), obj.Name, fallbackContext: obj.Name);

    /// <summary>
    /// How code in namespace <paramref name="fromNamespace"/> names <paramref name="obj"/>'s type:
    /// bare when it is declared in that same namespace, otherwise <c>global::</c>-qualified — a
    /// <c>using</c> could be shadowed by a same-named type in the referring namespace.
    /// </summary>
    public static string TypeRef(MetaData obj, MetaData root, GenConfig config, string fromNamespace)
    {
        var ns = Namespace(obj, config);
        var name = TypeName(obj, root);
        return ns == fromNamespace ? name : $"global::{ns}.{name}";
    }

    /// <summary>
    /// rc.19 R65: <paramref name="obj"/>'s type (entity, value object, projection, report),
    /// <c>global::</c>-qualified — how every generated file outside the type's own declaration
    /// names it, so no namespace can capture the name (CS0234) and no pair of <c>using</c>s can make
    /// it ambiguous (CS0104).
    /// </summary>
    public static string GlobalRef(MetaData obj, GenConfig config) =>
        Global(Namespace(obj, config), CSharpNaming.Pascal(obj.Name));

    /// <summary><paramref name="name"/> in <paramref name="ns"/> as a <c>global::</c>-qualified name.
    /// A <paramref name="name"/> that is already qualified (<c>global::…</c>) is returned as is.</summary>
    public static string Global(string ns, string name) =>
        name.StartsWith("global::", StringComparison.Ordinal) ? name : $"global::{ns}.{name}";

    /// <summary>
    /// rc.19 R65: <see cref="GenConfig.ContextTypeName"/> as generated code names it from any
    /// namespace: as written when already <c>global::</c>-qualified, <c>global::</c> + the name when
    /// dotted (the adopter named its namespace), otherwise in <see cref="GenConfig.Namespace"/>,
    /// where the DbContext generator declares it.
    /// </summary>
    public static string ContextTypeRef(GenConfig config)
    {
        var name = config.ContextTypeName;
        if (name.StartsWith("global::", StringComparison.Ordinal)) return name;
        return name.Contains('.') ? "global::" + name : Global(config.Namespace, name);
    }

    /// <summary>
    /// How code in <paramref name="fromNamespace"/> names <paramref name="obj"/>'s type when a
    /// <c>using</c> of its namespace is in scope: bare, unless another object in the model shares its
    /// short name and it lives in another namespace — then <c>global::</c>-qualified, since a bare
    /// name would be ambiguous (CS0104) between the two namespaces' types.
    /// </summary>
    public static string ShortRef(MetaData obj, MetaData root, GenConfig config, string fromNamespace) =>
        SharesShortName(obj, root) ? TypeRef(obj, root, config, fromNamespace) : TypeName(obj, root);

    /// <summary>
    /// A name for <paramref name="obj"/> unique in the model, for a PRIVATE member of a generated class
    /// (a mapper method): its PascalCase name, prefixed with its PascalCased package when another
    /// object shares the short name. Types are never renamed (ruling R52); this names members only.
    /// </summary>
    public static string MemberKey(MetaData obj, MetaData root) =>
        SharesShortName(obj, root) && PackageBindingResolver.EffectivePackage(obj) is { Length: > 0 } pkg
            ? string.Concat(pkg.Split(PACKAGE_SEPARATOR).Select(CSharpNaming.Pascal)) + TypeName(obj, root)
            : TypeName(obj, root);

    private static bool SharesShortName(MetaData obj, MetaData root) =>
        root.Children().Count(c => c.Type == TYPE_OBJECT && c.Name == obj.Name) > 1;

    /// <summary>
    /// The object a field's <c>@objectRef</c> names (ADR-0059 R7): the target the loader bound,
    /// resolved in the package of the node that declared the attribute even when the field is
    /// inherited through <c>extends</c>. Never a bare short-name scan.
    /// </summary>
    public static MetaObject? ResolveFieldRef(MetaData field, MetaData root) =>
        global::MetaObjects.NamingRefs.RefTarget(field, MetaObjects.Core.Field.FieldConstants.FIELD_ATTR_OBJECT_REF) as MetaObject;

    /// <summary>The payload shape a CANONICAL <c>@payloadRef</c> value names, resolved exactly
    /// (ADR-0059 R7), or null: <c>pkg::Name</c> binds that package's object, <c>::Name</c> and a
    /// bare <c>Name</c> bind the root-level object; no short-name scan and no package applied.
    /// Prefer <see cref="PayloadShapeOf"/> on the template node. <paramref name="referrerPkg"/> is
    /// ignored: a canonical value is absolute.
    /// #210 — a template-level payload target is an <c>object.value</c> OR a SOURCELESS
    /// <c>object.projection</c> ("sourceless" per the #248 persistability contract: no
    /// declared/inherited <c>source.*</c> child; nested <c>@objectRef</c> targets stay
    /// value-only — <c>RenderHelperGenerator.ResolveNestedObjectRef</c>).</summary>
    public static MetaData? ResolveValueObject(MetaRoot root, string payloadRef, string referrerPkg = "") =>
        AsPayloadShape(global::MetaObjects.NamingRefs.LookupCanonical(root, payloadRef, TYPE_OBJECT));

    /// <summary>
    /// The payload shape the reference attribute <paramref name="attr"/> of <paramref name="tmpl"/>
    /// (<c>@payloadRef</c> / <c>@responseRef</c>) is bound to, or null when it is unbound or not
    /// a payload shape (ADR-0059 R7).
    /// </summary>
    public static MetaData? PayloadShapeOf(MetaData tmpl, string attr) =>
        AsPayloadShape(global::MetaObjects.NamingRefs.RefTarget(tmpl, attr));

    private static MetaData? AsPayloadShape(MetaData? obj)
    {
        if (obj is null) return null;
        if (obj.SubType == OBJECT_SUBTYPE_VALUE) return obj;
        if (obj.SubType != OBJECT_SUBTYPE_PROJECTION) return null;
        // ADR-0039: resolving — a source anywhere in the extends chain binds the
        // projection to a backing store, which disqualifies it as a payload shape.
        return obj.Children().Any(c => c.Type == TYPE_SOURCE) ? null : obj;
    }
}
