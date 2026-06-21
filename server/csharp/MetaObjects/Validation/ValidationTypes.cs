using MetaObjects.Meta;

namespace MetaObjects.Validation;

/// <summary>
/// Declares that one attribute on a node is a cross-reference to another node. A provider
/// attaches these to its TypeDefinition; the registry-derived walk resolves them against the
/// symbol table — so a new reference attr validates for free. Mirrors the TS/Java model.
/// </summary>
public sealed record ReferenceDescriptor(
    string Attr,
    string TargetType,
    string? TargetSubType,
    bool DottedFieldPath,
    string ErrorCode);

/// <summary>Resolve a ref string to its object node.</summary>
public interface ISymbolTable
{
    MetaData? ResolveObject(string reference);
}

/// <summary>Handed to every validator: the symbol table + an error sink.</summary>
public interface IValidationContext
{
    ISymbolTable Symbols { get; }
    void Error(string code, MetaData node, string message);
}

/// <summary>An imperative validator for a node, carried by its TypeDefinition.</summary>
public delegate void NodeValidator(MetaData node, IValidationContext ctx);
