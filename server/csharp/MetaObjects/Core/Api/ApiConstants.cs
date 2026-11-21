// Declared API surface constants (ADR-0030, ADR-0066) — subtypes and attribute keys for
// `api.*`, `operation.*` and `binding.*`.
//
// Colocated per ADR-0003. Mirrors
// server/typescript/packages/metadata/src/core/api/api-constants.ts. The type-name
// constants live in Shared/BaseTypes.cs beside every other base type.

using System.Text.RegularExpressions;

namespace MetaObjects.Core.Api;

/// <summary>Constants of the declared API surface: subtypes, attr keys, reserved names.</summary>
public static partial class ApiConstants
{
    /// <summary>A request/response surface whose children are operations. The axis is the
    /// interaction model, never the protocol (ADR-0030).</summary>
    public const string API_SUBTYPE_OPERATIONAL = "operational";
    public static readonly string[] API_SUBTYPES = [API_SUBTYPE_OPERATIONAL];

    /// <summary>Changes state; takes an <c>object.value</c>.</summary>
    public const string OPERATION_SUBTYPE_COMMAND = "command";
    /// <summary>Reads; returns a projection, entity or value.</summary>
    public const string OPERATION_SUBTYPE_QUERY = "query";
    public static readonly string[] OPERATION_SUBTYPES = [OPERATION_SUBTYPE_COMMAND, OPERATION_SUBTYPE_QUERY];

    /// <summary>The HTTP binding of an operation (overrides the derived method and path).</summary>
    public const string BINDING_SUBTYPE_REST = "rest";
    public static readonly string[] BINDING_SUBTYPES = [BINDING_SUBTYPE_REST];

    // Attrs on operation.* (and @permission / @public on transition.* too)
    public const string OPERATION_ATTR_INPUT_REF = "inputRef";
    public const string OPERATION_ATTR_OUTPUT_REF = "outputRef";
    public const string OPERATION_ATTR_OBJECT_REF = "objectRef";
    public const string OPERATION_ATTR_TRANSITIONS = "transitions";
    public const string OPERATION_ATTR_PERMISSION = "permission";
    public const string OPERATION_ATTR_PUBLIC = "public";
    public const string OPERATION_ATTR_ERRORS = "errors";
    public const string OPERATION_ATTR_MANY = "many";

    // Attrs on binding.rest
    public const string BINDING_ATTR_METHOD = "method";
    public const string BINDING_ATTR_PATH = "path";
    public static readonly string[] HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

    /// <summary>Names a declared operation or a transition may not take: they are the derived
    /// CRUD verbs of the same service (ERR_TRANSITION_NAME_COLLISION).</summary>
    public static readonly string[] RESERVED_OPERATION_NAMES = ["create", "get", "list", "update", "delete"];

    /// <summary>A declared @permission: a dotted identifier path; a package prefix may use "::". Anchored
    /// with \z so a trailing newline does not match.</summary>
    public static readonly Regex PERMISSION_NAME_PATTERN =
        new(@"^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z_][A-Za-z0-9_]*)*\z", RegexOptions.CultureInvariant);

    /// <summary>A declared business error code: lower snake case.</summary>
    public static readonly Regex BUSINESS_ERROR_CODE_PATTERN =
        new(@"^[a-z][a-z0-9]*(_[a-z0-9]+)*\z", RegexOptions.CultureInvariant);

    /// <summary>The codes the enforcing shell answers on its own (ADR-0066 §6), in the order it checks them.
    /// The rules-names generator writes them as constants.</summary>
    public static readonly string[] SHELL_ERROR_CODES =
        ["not_found", "forbidden", "invalid_transition", "transition_condition_failed", "state_managed"];

    // Declared after SHELL_ERROR_CODES: static initializers run in textual order.
    /// <summary>Wire error codes an operation's route answers on its own, so a body may not declare them
    /// in @errors (O5): the enforcing shell's codes (ADR-0066) and the API contract's generic ones.</summary>
    public static readonly string[] RESERVED_ERROR_CODES =
    [
        .. SHELL_ERROR_CODES,
        "validation", "invalid_json", "invalid_id", "method_not_allowed", "constraint_violation", "internal",
    ];
}
