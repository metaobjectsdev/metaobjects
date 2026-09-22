// ADR-0056 — the ONE answer, for every C# generator, to "what is this value object's type
// called, and in which namespace".
//
// A value object's C# type is emitted once, by EntityGenerator, as a POCO in the value object's
// own namespace (PackageBindingResolver). Every generator that names it — the entity tier's
// owned-type navigations, and the template tier's render helpers, parsers, extractors and api-docs
// — asks this class, so none of them can disagree with the declaration.
//
// Naming (ADR-0044's rule, applied to the POCOs): a value object whose short name no other object
// in the model shares emits bare (PascalCase). When another object shares it — a second value
// object, or an entity or projection in another package — every value object of that name emits
// package-qualified (acme::alpha::Note -> AcmeAlphaNote). TypeScript's entityFile() and Python's
// entity model do the same for their flat modules (#228). C# needs it because the default package
// binding flattens every package into one namespace and every generated file lands in one
// directory, so a second `Note` would collide on the type AND on the file name (`Note.g.cs`).
// Entities and projections keep their names: only the value object moves. A derived name that
// still collides fails loud (ERR_PAYLOAD_NAME_COLLISION).

using System.Runtime.CompilerServices;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Object.ObjectConstants;

namespace MetaObjects.Codegen;

/// <summary>The emitted C# name and namespace of a value object's POCO (ADR-0056).</summary>
public static class ValueObjectNames
{
    // A codegen-time error, the peer of MetaObjects.Render.Verify's drift codes. Not in the shared
    // ErrorCode ledger: it is raised by codegen, never by the loader.
    private const string ERR_PAYLOAD_NAME_COLLISION = "ERR_PAYLOAD_NAME_COLLISION";

    // Loaded metadata is read-only, so the name map is a pure function of the root.
    private static readonly ConditionalWeakTable<MetaData, IReadOnlyDictionary<string, string>> Cache = new();

    /// <summary>True for a value-object shape: an <c>object.value</c>, or an <c>object.projection</c>
    /// with no <c>source.*</c> anywhere in its super chain (#210 — pure shape, like a value object).</summary>
    public static bool IsValueShape(MetaData obj) =>
        obj.Type == TYPE_OBJECT
        && (obj.SubType == OBJECT_SUBTYPE_VALUE
            || (obj.SubType == OBJECT_SUBTYPE_PROJECTION && !obj.Children().Any(c => c.Type == TYPE_SOURCE)));

    /// <summary>
    /// The emitted C# type name for <paramref name="obj"/>: the ADR-0044 collision-aware name for an
    /// <c>object.value</c>, and the PascalCase name for anything else.
    /// </summary>
    public static string TypeName(MetaData obj, MetaData root) =>
        obj.SubType == OBJECT_SUBTYPE_VALUE && Names(root).TryGetValue(obj.ResolutionKey(), out var name)
            ? name
            : CSharpNaming.Pascal(obj.Name);

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
    /// The object a field's <c>@objectRef</c> names, resolved FQN-exact / package-local (ADR-0042)
    /// in the FIELD's declaring package — which differs from the owner's when the field is
    /// inherited through <c>extends</c>. Never a bare short-name scan: that binds whichever
    /// same-named object loaded first.
    /// </summary>
    public static MetaObject? ResolveFieldRef(MetaData field, MetaData root) =>
        field.Attr(MetaObjects.Core.Field.FieldConstants.FIELD_ATTR_OBJECT_REF) is string oref && oref.Length > 0
            ? global::MetaObjects.NamingRefs.ResolveObjectRef(
                root, oref, field.Parent is { } p ? global::MetaObjects.NamingRefs.EffectivePackage(p) : "") as MetaObject
            : null;

    /// <summary>The value-object name map: <c>ResolutionKey()</c> → emitted C# name.</summary>
    internal static IReadOnlyDictionary<string, string> Names(MetaData root) =>
        Cache.GetValue(root, Assign);

    private static IReadOnlyDictionary<string, string> Assign(MetaData root)
    {
        // ADR-0039: Children() — resolving root scan (behavior-identical; the root has no super).
        var byShortName = root.Children()
            .Where(c => c.Type == TYPE_OBJECT)
            .GroupBy(c => c.Name, StringComparer.Ordinal);

        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var group in byShortName)
        {
            var members = group.ToList();
            foreach (var vo in members.Where(o => o.SubType == OBJECT_SUBTYPE_VALUE))
                names[vo.ResolutionKey()] = members.Count == 1
                    ? CSharpNaming.Pascal(vo.Name)
                    : PackageQualifiedName(PackageBindingResolver.EffectivePackage(vo) ?? "", vo.Name);
        }

        // Backstop, in FQN order so which pair the message names is a pure function of the model.
        var ownerOf = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var fqn in names.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            if (ownerOf.TryGetValue(names[fqn], out var existing))
                throw new InvalidOperationException(
                    $"{ERR_PAYLOAD_NAME_COLLISION}: value object name collision: \"{names[fqn]}\" derives from both " +
                    $"\"{existing}\" and \"{fqn}\" — rename one value object or move it to a package that derives a distinct name");
            ownerOf[names[fqn]] = fqn;
        }
        return names;
    }

    /// <summary>ADR-0044 — PascalCase each <c>::</c>-segment of the package, concatenated, then the
    /// PascalCase short name (<c>acme::alpha::Note</c> → <c>AcmeAlphaNote</c>). A root-level node has
    /// nothing to qualify with and keeps its name; the loader already rejects two of those.</summary>
    private static string PackageQualifiedName(string pkg, string shortName) =>
        pkg.Length == 0
            ? CSharpNaming.Pascal(shortName)
            : string.Concat(pkg.Split(PACKAGE_SEPARATOR).Select(CSharpNaming.Pascal)) + CSharpNaming.Pascal(shortName);
}
