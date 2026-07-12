using MetaObjects.Loader;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Validation;

/// <summary>
/// The recursive validation walk, DERIVED FROM THE TYPE REGISTRY: each node's TypeDefinition
/// carries its reference descriptors + imperative validator, so a downstream provider's type
/// validates itself just by being registered. Per node: apply the type's declared references
/// (resolve against the symbol table), invoke its validator, recurse. Mirrors TS/Java.
/// </summary>
/// <remarks>
/// ADR-0039: the walk DESCENDS via <c>OwnChildren()</c> — a declaration-structure walk that
/// visits each physically-declared node exactly once (an inherited child is validated on its
/// declaring parent; resolving would double-visit). But a visited node's reference attr
/// (e.g. <c>@objectRef</c> / <c>@through</c>) may itself be INHERITED from an abstract base via
/// <c>extends</c>, so the attr is read via the RESOLVING <c>Attr</c> accessor. Matches the
/// cross-port reference 1:1 (TS <c>loader/validation-registry.ts:66</c> reads <c>node.attr(...)</c>
/// while descending via <c>ownChildren()</c>).
/// </remarks>
public static class RegisteredValidation
{
    public static IReadOnlyList<MetaError> Run(MetaData root, TypeRegistry registry)
    {
        var ctx = new ValidationContext(SymbolTable.Build(root));
        Walk(root, "", registry, ctx);
        return ctx.Errors;
    }

    private static void Walk(MetaData node, string referrerPkg, TypeRegistry registry, ValidationContext ctx)
    {
        // ADR-0042: a top-level object establishes the package context for its subtree; nested
        // ref-bearing nodes (relationship / field.object / identity.reference) resolve BARE
        // refs against it. Nested nodes carry no `package`, so they inherit the enclosing
        // object's effective package (via file-default, else the threaded context).
        string pkg = node.Type == TYPE_OBJECT ? NamingRefs.EffectivePackage(node) : referrerPkg;

        var def = registry.Find(node.Type, node.SubType);
        if (def is not null)
        {
            foreach (var desc in def.References)
            {
                // ADR-0039: resolving — a reference attr (e.g. @objectRef/@through) may be
                // inherited via extends; read the effective value (TS validation-registry.ts:66).
                if (node.Attr(desc.Attr) is not string raw || raw.Length == 0) continue;
                int dot = raw.IndexOf('.');
                var entityRef = (desc.DottedFieldPath && dot >= 0) ? raw[..dot] : raw;
                var target = ctx.Symbols.ResolveObject(entityRef, pkg);
                // Qualify the node name with its owning entity (e.g. "Order.items") so the
                // error is locatable from the message alone, not just the source envelope.
                var qname = string.IsNullOrEmpty(node.Parent?.Name) ? node.Name : $"{node.Parent!.Name}.{node.Name}";
                if (target is null)
                {
                    // ADR-0042 §5: a did-you-mean hint listing same-short-name objects in other packages.
                    ctx.Error(desc.ErrorCode, node,
                        $"{node.Type}.{node.SubType} \"{qname}\" @{desc.Attr} \"{raw}\" does not resolve to an object." +
                        NamingRefs.DidYouMeanHint(node.Root(), entityRef));
                }
                else if (target.Type != desc.TargetType ||
                         (desc.TargetSubType is not null && target.SubType != desc.TargetSubType))
                {
                    var want = desc.TargetSubType is not null ? $"{desc.TargetType}.{desc.TargetSubType}" : desc.TargetType;
                    ctx.Error(desc.ErrorCode, node,
                        $"{node.Type}.{node.SubType} \"{qname}\" @{desc.Attr} \"{raw}\" resolves to " +
                        $"{target.Type}.{target.SubType}, not a {want}.");
                }
            }
            def.Validate?.Invoke(node, ctx);
        }
        foreach (var child in node.OwnChildren()) Walk(child, pkg, registry, ctx);
    }

    private sealed class SymbolTable : ISymbolTable
    {
        // ADR-0042: key every top-level object by its canonical resolution key ONLY (the FQN,
        // or the bare name for a root-level/empty-package object) — NO bare-name fallback, so a
        // bare ref never binds a same-named object in another package. Mirrors TS SymbolTableImpl.
        private readonly Dictionary<string, MetaData> _byKey = new(StringComparer.Ordinal);

        public static SymbolTable Build(MetaData root)
        {
            var t = new SymbolTable();
            foreach (var c in root.OwnChildren())
            {
                if (c.Type == TYPE_OBJECT) t._byKey[c.ResolutionKey()] = c;
            }
            return t;
        }

        /// <summary>ADR-0042 package-local resolution: FQN → exact resolution-key match; bare →
        /// the referrer's own package (<c>&lt;referrerPkg&gt;::&lt;ref&gt;</c>), else a root-level object.</summary>
        public MetaData? ResolveObject(string reference, string referrerPkg)
        {
            if (reference.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal))
                return _byKey.GetValueOrDefault(reference);
            string localKey = referrerPkg.Length > 0 ? $"{referrerPkg}{PACKAGE_SEPARATOR}{reference}" : reference;
            return _byKey.GetValueOrDefault(localKey) ?? _byKey.GetValueOrDefault(reference);
        }
    }

    private sealed class ValidationContext(ISymbolTable symbols) : IValidationContext
    {
        public ISymbolTable Symbols { get; } = symbols;
        public List<MetaError> Errors { get; } = [];

        public void Error(string code, MetaData node, string message)
        {
            // The core descriptors use built-in codes; a downstream provider's custom code
            // (not a defined enum member — including a numeric string) maps to ERR_UNKNOWN for
            // now (the message carries the detail). Enum.IsDefined guards numeric-string parses
            // so behaviour matches Python's value-lookup mapping exactly.
            var ec = System.Enum.TryParse<ErrorCode>(code, out var parsed)
                && System.Enum.IsDefined(typeof(ErrorCode), parsed)
                ? parsed : ErrorCode.ERR_UNKNOWN;
            Errors.Add(new MetaError(message, ec, Envelope: node.Source));
        }
    }
}
