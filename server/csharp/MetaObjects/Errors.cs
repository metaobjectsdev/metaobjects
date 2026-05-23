namespace MetaObjects;

/// <summary>Stable, language-neutral error codes — mirrors fixtures/conformance/ERROR-CODES.json.</summary>
public enum ErrorCode
{
    ERR_MALFORMED_JSON,
    ERR_TOP_LEVEL_NOT_OBJECT,
    ERR_UNKNOWN_TYPE,
    ERR_UNKNOWN_SUBTYPE,
    ERR_MISSING_SUBTYPE,
    ERR_DUPLICATE_NAME,
    ERR_UNRESOLVED_SUPER,
    ERR_INVALID_SUBTYPE_CHILD,
    ERR_UNKNOWN_ATTR,
    ERR_MISSING_REQUIRED_ATTR,
    ERR_BAD_ATTR_VALUE,
    ERR_BAD_DEFAULT_SORT_FIELD,
    ERR_PROVIDER_DEPENDENCY_CYCLE,
    ERR_PROVIDER_DUPLICATE_ID,
    ERR_PROVIDER_MISSING_DEPENDENCY,
    ERR_PROVIDER_ATTR_CONFLICT,
    ERR_SUBTYPE_RULE_VIOLATION,
    ERR_OVERLAY_NO_TARGET,
    ERR_MALFORMED_YAML,
    ERR_INVALID_ORIGIN,
    ERR_BAD_ATTR_FILTER,
    ERR_STORAGE_WITHOUT_OBJECT_REF,
    ERR_STORAGE_FLATTENED_ARRAY,
    ERR_INVALID_TEMPLATE,
    ERR_UNKNOWN,
}

/// <summary>A collected load error. Carries the stable code the conformance runner compares.</summary>
public sealed record MetaError(string Message, ErrorCode Code = ErrorCode.ERR_UNKNOWN,
    string? Source = null, string? Path = null);

/// <summary>Thrown for top-level structural parse failures the TS parser also throws on
/// (malformed JSON, non-object root, unknown root type). The loader catches it and
/// converts to a collected <see cref="MetaError"/>.</summary>
public sealed class ParseException : System.Exception
{
    public ErrorCode Code { get; }
    /// <summary>The metadata source file path or identifier (distinct from Exception.Source).</summary>
    public string? SourceFile { get; }
    public string? NodePath { get; }
    public ParseException(string message, ErrorCode code = ErrorCode.ERR_UNKNOWN,
        string? sourceFile = null, string? nodePath = null) : base(message)
        => (Code, SourceFile, NodePath) = (code, sourceFile, nodePath);
}

/// <summary>Metamodel-level error that is not a parse error — provider composition
/// failures (dependency cycle, missing dependency, attr conflict). Carries the same
/// stable <see cref="ErrorCode"/> as ParseException for cross-language conformance.</summary>
public sealed class MetaModelException(string message, ErrorCode code = ErrorCode.ERR_UNKNOWN)
    : System.Exception(message) { public ErrorCode Code => code; }
