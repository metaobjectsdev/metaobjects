// API settings — `api` in .metaobjects/config.json, read by every port's codegen: the page size of
// a generated list route (`api.pagination`) and what a generated create/PUT/PATCH route does with a
// body key the entity does not declare (`api.unknownFields`). Carried on the loaded root, like
// WireFormat.

namespace MetaObjects.Meta;

/// <summary>What a generated write route does with an undeclared body key (<c>api.unknownFields</c>).</summary>
public enum UnknownFieldsMode
{
    /// <summary>The default: <c>400 { "error": "unknown_fields", "fields": [...] }</c>, nothing written.</summary>
    Reject,
    /// <summary>The behaviour before 1.3: undeclared keys are silently ignored.</summary>
    Drop,
}

/// <summary><c>api.pagination</c>: a list route with no <c>limit</c> returns <paramref name="DefaultLimit"/> rows,
/// and a <c>limit</c> above <paramref name="MaxLimit"/> is <c>400 { "error": "limit_too_large", "maxLimit": N }</c>.</summary>
public sealed record ApiPagination(int DefaultLimit, int MaxLimit);

/// <summary>The project's <c>api</c> block. A project that sets nothing has no page size and rejects unknown fields.</summary>
public sealed record ApiSettings(ApiPagination? Pagination, UnknownFieldsMode UnknownFields = UnknownFieldsMode.Reject)
{
    /// <summary>What a tree loaded with no project carries.</summary>
    public static readonly ApiSettings Default = new(null, UnknownFieldsMode.Reject);

    /// <summary>What <c>dotnet meta init</c> writes for a new project.</summary>
    public const int InitDefaultLimit = 50;
    /// <summary>What <c>dotnet meta init</c> writes for a new project.</summary>
    public const int InitMaxLimit = 1000;

    /// <summary>The setting the tree <paramref name="node"/> belongs to carries, else <see cref="Default"/>.</summary>
    public static ApiSettings Of(MetaData node) =>
        node.Root() is MetaRoot root ? root.Api : Default;
}
