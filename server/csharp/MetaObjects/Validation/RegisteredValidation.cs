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
public static class RegisteredValidation
{
    public static IReadOnlyList<MetaError> Run(MetaData root, TypeRegistry registry)
    {
        var ctx = new ValidationContext(SymbolTable.Build(root));
        Walk(root, registry, ctx);
        return ctx.Errors;
    }

    private static void Walk(MetaData node, TypeRegistry registry, ValidationContext ctx)
    {
        var def = registry.Find(node.Type, node.SubType);
        if (def is not null)
        {
            foreach (var desc in def.References)
            {
                if (node.OwnAttr(desc.Attr) is not string raw || raw.Length == 0) continue;
                int dot = raw.IndexOf('.');
                var entityRef = (desc.DottedFieldPath && dot >= 0) ? raw[..dot] : raw;
                var target = ctx.Symbols.ResolveObject(entityRef);
                // Qualify the node name with its owning entity (e.g. "Order.items") so the
                // error is locatable from the message alone, not just the source envelope.
                var qname = string.IsNullOrEmpty(node.Parent?.Name) ? node.Name : $"{node.Parent!.Name}.{node.Name}";
                if (target is null)
                {
                    ctx.Error(desc.ErrorCode, node,
                        $"{node.Type}.{node.SubType} \"{qname}\" @{desc.Attr} \"{raw}\" does not resolve to an object.");
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
        foreach (var child in node.OwnChildren()) Walk(child, registry, ctx);
    }

    private sealed class SymbolTable : ISymbolTable
    {
        private readonly List<MetaData> _objects = [];

        public static SymbolTable Build(MetaData root)
        {
            var t = new SymbolTable();
            foreach (var c in root.OwnChildren())
            {
                if (c.Type == TYPE_OBJECT) t._objects.Add(c);
            }
            return t;
        }

        public MetaData? ResolveObject(string reference)
        {
            foreach (var o in _objects)
            {
                if (ValidationPasses.RefMatchesObject(o, reference)) return o;
            }
            return null;
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
