// `dotnet meta verify` — the deprecated-REFERENCE authoring lint (#305).
//
// `deprecated` / `replacedBy` are registered documentation attributes that nothing else reads. This
// lint warns when a node DEPENDS on a node carrying `deprecated`, through the reference kinds the
// metamodel has: `extends`, `@objectRef`, `@references` and an origin's `@from` / `@of` / `@via`.
// When the deprecated node also carries `replacedBy`, the finding names the replacement. Warnings
// only: nothing here reaches an exit code.
//
// SELF-REFERENCE IS NOT A FINDING, but only the literal case: the same node, or one of its own
// ANCESTORS (the recursive-FK shape, `Category.parentId` pointing back at `Category`). A different
// node under the same entity, such as a passthrough reading a deprecated sibling field, is a real
// dependency and warns.
//
// It reads the LOADED model through the RESOLVING accessors (ADR-0039), so a target that inherits
// `deprecated` from its abstract base counts, and walks DECLARATIONS (OwnChildren()), so an
// inherited reference is reported once.
//
// Mirrors the TS reference (server/typescript/packages/cli/src/lib/deprecation-lint.ts). The code,
// the message text and the fixtures are shared: fixtures/model-lint-conformance/.

using MetaObjects.Meta;
using static MetaObjects.Core.Documentation.DocumentationConstants;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Identity.IdentityConstants;
using static MetaObjects.Core.Relationship.RelationshipConstants;
using static MetaObjects.Persistence.Origin.OriginConstants;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Cli;

/// <summary>The advisory deprecated-reference lint <c>dotnet meta verify</c> runs on every invocation.</summary>
public static class DeprecationLint
{
    /// <summary>A node depends on a node that carries <c>deprecated</c>.</summary>
    public const string WARN_DEPRECATED_REFERENCE = "WARN_DEPRECATED_REFERENCE";

    /// <summary>Opt-out environment variable, beside <c>--no-deprecation-lint</c> (Node <c>meta</c> parity).</summary>
    public const string EnvOptOut = "META_NO_DEPRECATION_LINT";

    /// <summary>Report every reference INTO a <c>deprecated</c> node.</summary>
    public static List<LintFinding> Lint(MetaData root)
    {
        var findings = new List<LintFinding>();
        Walk(root, root, "", findings);
        return findings;
    }

    private static void Walk(MetaData root, MetaData node, string prefix, List<LintFinding> findings)
    {
        // OWN-ONLY (ADR-0039 sanctioned case): report each reference at its declaration.
        foreach (var child in node.OwnChildren())
        {
            // An origin has no name of its own: report it against the field it belongs to.
            var path = child.Type == TYPE_ORIGIN ? prefix
                : prefix == "" ? child.ResolutionKey()
                : $"{prefix}.{child.Name}";
            CheckNode(root, child, path, findings);
            Walk(root, child, path, findings);
        }
    }

    private static string PackageOf(MetaData node) => node.Package ?? node.FileDefaultPackage ?? "";

    /// <summary>The nearest enclosing <c>object.*</c> (objects are never nested in this metamodel).</summary>
    private static MetaObject? OwningObject(MetaData node)
    {
        var cursor = node.Parent;
        while (cursor is not null and not MetaObject) cursor = cursor.Parent;
        return cursor as MetaObject;
    }

    /// <summary>The object's FQN, or <c>&lt;object FQN&gt;.&lt;name&gt;</c> for something nested inside one.</summary>
    private static string AddressOf(MetaData node)
    {
        if (node is MetaObject obj) return obj.ResolutionKey();
        return OwningObject(node) is { } owner ? $"{owner.ResolutionKey()}.{node.Name}" : node.Name;
    }

    /// <summary>The same node, or one of <paramref name="referrer"/>'s ancestors. Deliberately not symmetric.</summary>
    private static bool IsSelfReference(MetaData referrer, MetaData target)
    {
        for (MetaData? cursor = referrer; cursor is not null; cursor = cursor.Parent)
            if (ReferenceEquals(cursor, target)) return true;
        return false;
    }

    /// <summary>Report <paramref name="target"/> when it carries <c>deprecated</c>; true when a finding was added.</summary>
    private static bool Consider(MetaData referrer, string path, string verb, MetaData target, List<LintFinding> findings)
    {
        if (IsSelfReference(referrer, target)) return false;
        // RESOLVING (ADR-0039): `deprecated` inherited through the target's own extends chain counts.
        // Presence means deprecated: an empty reason still counts. Only an absent attr does not.
        if (target.Attr(DOC_ATTR_DEPRECATED) is not string reason) return false;
        var message = $"{verb} deprecated {target.Type}.{target.SubType} {AddressOf(target)}{(reason != "" ? ": " + reason : "")}";
        if (target.Attr(DOC_ATTR_REPLACED_BY) is string { Length: > 0 } replacedBy)
        {
            // The replacement is its own sentence, so the one before it ends first.
            var ended = message.EndsWith('.') || message.EndsWith('!') || message.EndsWith('?') ? message : message + ".";
            message = $"{ended} Replaced by {replacedBy}.";
        }
        findings.Add(new LintFinding(WARN_DEPRECATED_REFERENCE, path, message));
        return true;
    }

    private static string HeadOf(string raw)
    {
        var dot = raw.IndexOf('.');
        return dot < 0 ? raw : raw[..dot];
    }

    private static MetaObject? ResolveEntity(MetaData root, string reference, string referrerPkg) =>
        NamingRefs.ResolveObjectRef(root, reference, referrerPkg) as MetaObject;

    /// <summary>The relationship or <c>identity.reference</c> child named <paramref name="hopName"/>.</summary>
    private static MetaData? FindHop(MetaObject entity, string hopName) =>
        // RESOLVING (ADR-0039): an inherited hop counts.
        entity.Children().FirstOrDefault(c => c.Name == hopName
            && (c.Type == TYPE_RELATIONSHIP || (c.Type == TYPE_IDENTITY && c.SubType == IDENTITY_SUBTYPE_REFERENCE)));

    private static MetaObject? HopTarget(MetaData hop) =>
        NamingRefs.RefTarget(hop, hop.Type == TYPE_RELATIONSHIP ? RELATIONSHIP_ATTR_OBJECT_REF : IDENTITY_REFERENCE_ATTR_REFERENCES) as MetaObject;

    /// <summary>
    /// A dotted <c>Entity</c> or <c>Entity.field</c> reference: the field first (the more specific
    /// target), the entity only when the field was silent. A failed resolution is silent.
    /// </summary>
    private static void CheckEntityFieldPath(
        MetaData referrer, string path, string verb, string raw, MetaObject? entity, List<LintFinding> findings)
    {
        if (entity is null) return;
        var head = HeadOf(raw);
        var fieldName = raw.Length > head.Length ? raw[(head.Length + 1)..] : "";
        if (fieldName != "" && entity.FindField(fieldName) is { } field && Consider(referrer, path, verb, field, findings)) return;
        Consider(referrer, path, verb, entity, findings);
    }

    /// <summary>Walk an <c>@via</c> path, checking the head entity and every hop; stop at the first segment that does not resolve.</summary>
    private static void CheckVia(MetaData root, MetaData origin, string path, string verb, string via, string pkg, List<LintFinding> findings)
    {
        var segments = via.Split('.');
        if (segments[0] == "") return;
        var current = ResolveEntity(root, segments[0], pkg);
        if (current is null) return;
        Consider(origin, path, verb, current, findings);
        foreach (var hopName in segments.Skip(1))
        {
            var hop = FindHop(current, hopName);
            if (hop is null) return;
            Consider(origin, path, verb, hop, findings);
            var next = HopTarget(hop);
            if (next is null) return;
            Consider(origin, path, verb, next, findings);
            current = next;
        }
    }

    private static void CheckOrigin(MetaData root, MetaData origin, string path, List<LintFinding> findings)
    {
        var pkg = OwningObject(origin) is { } owner ? PackageOf(owner) : "";
        var label = $"origin.{origin.SubType}";
        // ADR-0039: own — origin.* never inherits (ADR-0029).
        if (origin.OwnAttr(ORIGIN_PASSTHROUGH_ATTR_FROM) is string { Length: > 0 } from)
            CheckEntityFieldPath(origin, path, $"{label} @from references", from, ResolveEntity(root, HeadOf(from), pkg), findings);
        if (origin.OwnAttr(ORIGIN_AGGREGATE_ATTR_OF) is string { Length: > 0 } of)
            CheckEntityFieldPath(origin, path, $"{label} @of references", of, ResolveEntity(root, HeadOf(of), pkg), findings);
        if (origin.OwnAttr(ORIGIN_PASSTHROUGH_ATTR_VIA) is string { Length: > 0 } via)
            CheckVia(root, origin, path, $"{label} @via references", via, pkg, findings);
    }

    private static void CheckNode(MetaData root, MetaData node, string path, List<LintFinding> findings)
    {
        if (node.SuperData is { } super) Consider(node, path, "extends", super, findings);

        if (node.Type is TYPE_RELATIONSHIP or TYPE_FIELD)
        {
            // ADR-0059 R7: the target the loader bound, resolved where @objectRef was declared.
            var attr = node.Type == TYPE_RELATIONSHIP ? RELATIONSHIP_ATTR_OBJECT_REF : FIELD_ATTR_OBJECT_REF;
            if (NamingRefs.RefTarget(node, attr) is MetaObject target)
                Consider(node, path, "references (@objectRef)", target, findings);
        }

        if (node.Type == TYPE_IDENTITY && node.SubType == IDENTITY_SUBTYPE_REFERENCE
            && node.Attr(IDENTITY_REFERENCE_ATTR_REFERENCES) is string { Length: > 0 } raw)
            CheckEntityFieldPath(node, path, "references (@references)", raw,
                NamingRefs.RefTarget(node, IDENTITY_REFERENCE_ATTR_REFERENCES) as MetaObject, findings);

        if (node.Type == TYPE_ORIGIN) CheckOrigin(root, node, path, findings);
    }
}
