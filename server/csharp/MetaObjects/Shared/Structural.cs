// Structural vocabulary — reserved body keys, JSON special keys, separators, wildcards, package paths.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/shared/structural.ts.
// Wire-format identifiers; do not rename.

namespace MetaObjects.Shared;

/// <summary>
/// Reserved structural body keys + the @ prefix + the :: package separator + the
/// fused type.subType key separator + the child-rule wildcard.
/// </summary>
public static class Structural
{
    // -----------------------------------------------------------------------
    // Reserved structural body keys (redesigned format — NOT @-prefixed, NOT attrs)
    //
    // Every node body is a map whose only permitted non-@ keys are these. The
    // canonical body-key order is: name, package, extends, abstract, overlay,
    // isArray, @-attrs (alphabetical), children.
    // -----------------------------------------------------------------------

    public const string RESERVED_KEY_NAME     = "name";
    public const string RESERVED_KEY_PACKAGE  = "package";
    /// <summary>The supertype reference.</summary>
    public const string RESERVED_KEY_EXTENDS  = "extends";
    /// <summary>true → the node is abstract.</summary>
    public const string RESERVED_KEY_ABSTRACT = "abstract";
    /// <summary>true → re-opens an existing same-named node.</summary>
    public const string RESERVED_KEY_OVERLAY  = "overlay";
    /// <summary>true → the node is an array.</summary>
    public const string RESERVED_KEY_IS_ARRAY = "isArray";
    public const string RESERVED_KEY_CHILDREN = "children";
    /// <summary>attr-child-node body key carrying the typed value.</summary>
    public const string RESERVED_KEY_VALUE    = "value";

    public static readonly HashSet<string> RESERVED_KEYS = new HashSet<string>
    {
        RESERVED_KEY_NAME,
        RESERVED_KEY_PACKAGE,
        RESERVED_KEY_EXTENDS,
        RESERVED_KEY_ABSTRACT,
        RESERVED_KEY_OVERLAY,
        RESERVED_KEY_IS_ARRAY,
        RESERVED_KEY_CHILDREN,
        RESERVED_KEY_VALUE,
    };

    // -----------------------------------------------------------------------
    // JSON document special keys (top-level, ignored during wrapper-key detection)
    // -----------------------------------------------------------------------

    public const string JSON_KEY_SCHEMA = "$schema";

    // -----------------------------------------------------------------------
    // Inline attribute prefix + fused type.subType key separator
    // -----------------------------------------------------------------------

    public const string ATTR_PREFIX = "@";

    /// <summary>Separator fusing type and subType in a node's wrapper key (<c>object.entity</c>).</summary>
    public const string TYPE_SUBTYPE_SEPARATOR = ".";

    // -----------------------------------------------------------------------
    // Package path conventions
    // -----------------------------------------------------------------------

    /// <summary>Separator between package segments and between package and name.</summary>
    public const string PACKAGE_SEPARATOR = "::";

    /// <summary>
    /// FR-024 (ADR-0029): separator between an owner object and a nested child in a
    /// dotted <c>extends</c> reference (<c>Customer.id</c>, <c>acme::sales::Customer.id</c>).
    /// Names cannot contain <c>.</c>, so a <c>.</c> in the final <c>::</c>-segment of a ref
    /// unambiguously marks a child-targeting reference.
    /// </summary>
    public const string CHILD_REF_SEPARATOR = ".";

    /// <summary>Relative-reference "go up one level" marker.</summary>
    public const string PACKAGE_PARENT = "..";

    // -----------------------------------------------------------------------
    // Wildcard for child-rule matching
    // -----------------------------------------------------------------------

    public const string CHILD_RULE_WILDCARD = "*";
}
