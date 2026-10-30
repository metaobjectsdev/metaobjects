// Physical naming — ADR-0058: one project setting for how a metadata name becomes a
// physical database name, read by every port (codegen, migrate (TS-only), the runtime,
// verify). Mirrors the TypeScript reference (metadata/src/naming.ts): ColumnNamingStrategy /
// TableNamingRule / PhysicalNaming / the default + the root-carried lookup.

using MetaObjects.Persistence.Source;

namespace MetaObjects.Meta;

/// <summary>
/// How a field with no <c>@column</c> becomes a column name. One project setting,
/// <c>naming.columns</c> in <c>.metaobjects/config.json</c>, read by every port (ADR-0058):
/// the loaded root carries it (<see cref="PhysicalNaming.Of"/>), so codegen, the runtime and
/// verify resolve the same name. Not a metadata attr: <c>@column</c> is the per-field
/// override, this is the rule for the rest.
/// </summary>
public enum ColumnNamingStrategy
{
    /// <summary>Field name verbatim.</summary>
    Literal,
    /// <summary>camelCase / PascalCase → snake_case. The default — what <c>meta migrate</c>
    /// has always created.</summary>
    SnakeCase,
    /// <summary>camelCase / PascalCase → kebab-case.</summary>
    KebabCase,
}

/// <summary>
/// How an object with no physical-name attribute (<c>@table</c>/<c>@view</c>/...) and no
/// source name gets its table name: the entity (or source) name cased by this rule. The
/// entity-name fallback keeps the frozen legacy pluralizer under every rule
/// (<see cref="SourceNaming.Pluralize"/>).
/// </summary>
public enum TableNamingRule
{
    /// <summary>Casing verbatim; the entity-name fallback is still pluralized (see <see cref="MetaSource.PhysicalName"/>).</summary>
    Literal,
    /// <summary>camelCase / PascalCase → snake_case. The default — what <c>meta migrate</c>
    /// has always created.</summary>
    SnakeCase,
}

/// <summary>
/// The project's physical-naming rules: <c>naming</c> in <c>.metaobjects/config.json</c>
/// (ADR-0058). Both rules default to <see cref="Default"/>, equal to what <c>meta migrate</c>
/// has always created.
/// </summary>
public sealed record PhysicalNaming(ColumnNamingStrategy Columns, TableNamingRule Tables)
{
    /// <summary>The default in every port: snake_case columns, snake_case tables.</summary>
    public static readonly PhysicalNaming Default = new(ColumnNamingStrategy.SnakeCase, TableNamingRule.SnakeCase);

    /// <summary>
    /// The physical-naming rules for the tree <paramref name="node"/> belongs to: what its
    /// root carries, set by the project-aware load from <c>.metaobjects/config.json</c>
    /// (<see cref="MetaRoot.PhysicalNaming"/>), else <see cref="Default"/>. Read through the
    /// root, not passed around, so every consumer of one loaded model resolves the same
    /// physical names. Falls back to <see cref="Default"/> for a tree whose top is not a
    /// <see cref="MetaRoot"/> at all (an in-memory fragment with no loader-built root).
    /// </summary>
    public static PhysicalNaming Of(MetaData node) =>
        node.Root() is MetaRoot root ? root.PhysicalNaming : Default;

    /// <summary>A field's physical column name: its explicit <c>@column</c> (resolving, so an
    /// inherited override counts), else the field name through the project's column strategy.
    /// The loader's collision check compares THESE resolved names, not the raw field names.</summary>
    public static string ResolveColumnName(MetaField field)
    {
        if (field.DbColumn is { Length: > 0 } explicitColumn) return explicitColumn;
        return PhysicalNaming.Of(field).Columns switch
        {
            ColumnNamingStrategy.SnakeCase => SourceNaming.ToSnakeCase(field.Name),
            ColumnNamingStrategy.KebabCase => SourceNaming.ToSnakeCase(field.Name).Replace('_', '-'),
            _ => field.Name,
        };
    }

    /// <summary><paramref name="name"/> cased by the table rule — no pluralization (the
    /// caller decides whether to pluralize; see <see cref="MetaSource.PhysicalName"/>).</summary>
    public static string ApplyTableNamingRule(string name, TableNamingRule rule) =>
        rule == TableNamingRule.Literal ? name : SourceNaming.ToSnakeCase(name);
}
