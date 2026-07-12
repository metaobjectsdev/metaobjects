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

/// <summary>Resolve a ref string to its object node under the ADR-0042 package-local
/// contract. <paramref name="referrerPkg"/> is the effective package of the node that
/// declares the ref (a bare ref resolves in that package, else root-level).</summary>
public interface ISymbolTable
{
    MetaData? ResolveObject(string reference, string referrerPkg);
}

/// <summary>Handed to every validator: the symbol table + an error sink.</summary>
public interface IValidationContext
{
    ISymbolTable Symbols { get; }
    void Error(string code, MetaData node, string message);
}

/// <summary>
/// An imperative validator for a node, carried by its TypeDefinition.
/// INTENTIONALLY UNUSED BY CORE — do not remove as "dead code": it is an extension point
/// (a downstream provider registers a new type with its own validator + error codes — the
/// ADR-0023 thesis) and the escape hatch in the config-driven-validation design (#51) for
/// novel cross-field rules that fit no declarative shape. Core's per-type validation lives
/// in reference descriptors (live) + declarative rule-shapes (#51), not this hook.
/// </summary>
public delegate void NodeValidator(MetaData node, IValidationContext ctx);
