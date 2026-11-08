// Physical naming — ADR-0058: one project setting for how a metadata name becomes a
// physical database name, read by every port (codegen, migrate (TS-only), the runtime,
// verify). Mirrors the TypeScript reference (metadata/src/naming.ts): ColumnNamingStrategy /
// TableNamingRule / PhysicalNaming / the default + the root-carried lookup, and the
// NamingStrategies registry an application extends (ADR-0058 Amendment 1).

using MetaObjects.Persistence.Source;

namespace MetaObjects.Meta;

/// <summary>
/// How a field with no <c>@column</c> becomes a column name: a NAMED strategy, registered in
/// <see cref="NamingStrategies"/>. One project setting, <c>naming.columns</c> in
/// <c>.metaobjects/config.json</c>, read by every port (ADR-0058): the loaded root carries it
/// (<see cref="PhysicalNaming.Of"/>), so codegen, the runtime and verify resolve the same name.
/// The built-ins are <see cref="SnakeCase"/>, <see cref="Literal"/>, <see cref="KebabCase"/> and
/// <see cref="Pascal"/>; an application registers its own with
/// <see cref="NamingStrategies.RegisterColumns"/> (ADR-0058 Amendment 1). Not a metadata attr:
/// <c>@column</c> is the per-field override, this is the rule for the rest. Two strategies are
/// equal when their names are.
/// </summary>
public sealed class ColumnNamingStrategy : IEquatable<ColumnNamingStrategy>
{
    private readonly Func<string, string> _apply;

    internal ColumnNamingStrategy(string name, Func<string, string> apply)
    {
        Name = name;
        _apply = apply;
    }

    /// <summary>The name <c>naming.columns</c> selects it by.</summary>
    public string Name { get; }

    /// <summary><paramref name="name"/> (a field name) as a column name under this strategy.</summary>
    public string Apply(string name) => _apply(name);

    /// <summary>Field name verbatim.</summary>
    public static readonly ColumnNamingStrategy Literal = new("literal", n => n);

    /// <summary>camelCase / PascalCase → snake_case. The default — what <c>meta migrate</c>
    /// has always created.</summary>
    public static readonly ColumnNamingStrategy SnakeCase = new("snake_case", SourceNaming.ToSnakeCase);

    /// <summary>camelCase / PascalCase → kebab-case.</summary>
    public static readonly ColumnNamingStrategy KebabCase = new("kebab-case", n => SourceNaming.ToSnakeCase(n).Replace('_', '-'));

    /// <summary><c>pascal</c>: the first letter upper-cased, nothing else changed
    /// (<c>requestURL</c> → <c>RequestURL</c>, <c>npi</c> → <c>Npi</c>), so a camelCase model maps
    /// onto a schema whose columns are its field names with a capital first letter (EF Core's
    /// default) with no <c>@column</c>. Not a word split.</summary>
    public static readonly ColumnNamingStrategy Pascal = new("pascal", PhysicalNaming.ToPascalColumn);

    /// <inheritdoc/>
    public bool Equals(ColumnNamingStrategy? other) => other is not null && other.Name == Name;
    /// <inheritdoc/>
    public override bool Equals(object? obj) => Equals(obj as ColumnNamingStrategy);
    /// <inheritdoc/>
    public override int GetHashCode() => StringComparer.Ordinal.GetHashCode(Name);
    /// <summary>The name, as <c>.metaobjects/config.json</c> spells it.</summary>
    public override string ToString() => Name;
    /// <summary>Equal when the names are.</summary>
    public static bool operator ==(ColumnNamingStrategy? a, ColumnNamingStrategy? b) => a is null ? b is null : a.Equals(b);
    /// <summary>Different when the names are.</summary>
    public static bool operator !=(ColumnNamingStrategy? a, ColumnNamingStrategy? b) => !(a == b);
}

/// <summary>
/// How an object with no physical-name attribute (<c>@table</c>/<c>@view</c>/...) and no
/// source name gets its table name: the entity (or source) name cased by this NAMED rule,
/// registered in <see cref="NamingStrategies"/>. The entity-name fallback keeps the frozen
/// legacy pluralizer under every rule (<see cref="SourceNaming.Pluralize"/>). The built-ins are
/// <see cref="SnakeCase"/> and <see cref="Literal"/>; an application registers its own with
/// <see cref="NamingStrategies.RegisterTables"/>. Two rules are equal when their names are.
/// </summary>
public sealed class TableNamingRule : IEquatable<TableNamingRule>
{
    private readonly Func<string, string> _apply;

    internal TableNamingRule(string name, Func<string, string> apply)
    {
        Name = name;
        _apply = apply;
    }

    /// <summary>The name <c>naming.tables</c> selects it by.</summary>
    public string Name { get; }

    /// <summary><paramref name="name"/> cased by this rule — never pluralized (that is a
    /// separate, frozen step; see <see cref="MetaSource.PhysicalName"/>).</summary>
    public string Apply(string name) => _apply(name);

    /// <summary>Casing verbatim; the entity-name fallback is still pluralized (see <see cref="MetaSource.PhysicalName"/>).</summary>
    public static readonly TableNamingRule Literal = new("literal", n => n);

    /// <summary>camelCase / PascalCase → snake_case. The default — what <c>meta migrate</c>
    /// has always created.</summary>
    public static readonly TableNamingRule SnakeCase = new("snake_case", SourceNaming.ToSnakeCase);

    /// <inheritdoc/>
    public bool Equals(TableNamingRule? other) => other is not null && other.Name == Name;
    /// <inheritdoc/>
    public override bool Equals(object? obj) => Equals(obj as TableNamingRule);
    /// <inheritdoc/>
    public override int GetHashCode() => StringComparer.Ordinal.GetHashCode(Name);
    /// <summary>The name, as <c>.metaobjects/config.json</c> spells it.</summary>
    public override string ToString() => Name;
    /// <summary>Equal when the names are.</summary>
    public static bool operator ==(TableNamingRule? a, TableNamingRule? b) => a is null ? b is null : a.Equals(b);
    /// <summary>Different when the names are.</summary>
    public static bool operator !=(TableNamingRule? a, TableNamingRule? b) => !(a == b);
}

/// <summary>
/// ADR-0058 Amendment 1 — the physical-naming strategies, by name: the built-ins, and the ones
/// an application registers. <c>.metaobjects/config.json</c> selects one by name, and
/// <see cref="Config.NeutralConfig"/> refuses a name nothing here answers when it reads the file,
/// so an application registers BEFORE the project-aware load or codegen runs (a host's own
/// codegen runner, its startup). Process-wide, like the type registry an application extends.
/// Wrapping a built-in is one line:
/// <code>NamingStrategies.RegisterColumns("pascal-acronyms", n => n == "npi" ? "NPI" : ColumnNamingStrategy.Pascal.Apply(n));</code>
/// </summary>
public static class NamingStrategies
{
    /// <summary>The port this registry belongs to, as every port's unknown-strategy message names it.</summary>
    private const string Port = "C#";

    private static readonly object Gate = new();
    private static readonly List<ColumnNamingStrategy> ColumnList = [];
    private static readonly List<TableNamingRule> TableList = [];

    /// <summary>The column rules every port builds in, in the order the conformance corpus lists them.</summary>
    public static IReadOnlyList<ColumnNamingStrategy> BuiltInColumns { get; } =
        [ColumnNamingStrategy.SnakeCase, ColumnNamingStrategy.Literal, ColumnNamingStrategy.KebabCase, ColumnNamingStrategy.Pascal];

    /// <summary>The table rules every port builds in.</summary>
    public static IReadOnlyList<TableNamingRule> BuiltInTables { get; } = [TableNamingRule.SnakeCase, TableNamingRule.Literal];

    static NamingStrategies()
    {
        ColumnList.AddRange(BuiltInColumns);
        TableList.AddRange(BuiltInTables);
    }

    /// <summary>Every registered column strategy: the built-ins in corpus order, then the application's in registration order.</summary>
    public static IReadOnlyList<ColumnNamingStrategy> Columns
    {
        get { lock (Gate) { return [.. ColumnList]; } }
    }

    /// <summary>Every registered table rule: the built-ins, then the application's.</summary>
    public static IReadOnlyList<TableNamingRule> Tables
    {
        get { lock (Gate) { return [.. TableList]; } }
    }

    /// <summary>
    /// Registers a column strategy under <paramref name="name"/>, which
    /// <c>"naming": { "columns": "&lt;name&gt;" }</c> then selects. A built-in name cannot be
    /// replaced; registering one of your own again replaces it.
    /// </summary>
    public static ColumnNamingStrategy RegisterColumns(string name, Func<string, string> apply)
    {
        Validate(name, apply, BuiltInColumns.Any(s => s.Name == name), "column-naming");
        var strategy = new ColumnNamingStrategy(name, apply);
        lock (Gate) { Upsert(ColumnList, strategy, s => s.Name); }
        return strategy;
    }

    /// <summary>Registers a table rule under <paramref name="name"/>; see <see cref="RegisterColumns"/>.</summary>
    public static TableNamingRule RegisterTables(string name, Func<string, string> apply)
    {
        Validate(name, apply, BuiltInTables.Any(s => s.Name == name), "table-naming");
        var rule = new TableNamingRule(name, apply);
        lock (Gate) { Upsert(TableList, rule, s => s.Name); }
        return rule;
    }

    /// <summary>The column strategy registered as <paramref name="name"/>, if any.</summary>
    public static bool TryGetColumn(string name, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out ColumnNamingStrategy? strategy)
    {
        lock (Gate) { strategy = ColumnList.FirstOrDefault(s => s.Name == name); }
        return strategy is not null;
    }

    /// <summary>The table rule registered as <paramref name="name"/>, if any.</summary>
    public static bool TryGetTable(string name, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out TableNamingRule? rule)
    {
        lock (Gate) { rule = TableList.FirstOrDefault(s => s.Name == name); }
        return rule is not null;
    }

    /// <summary>The column strategy registered as <paramref name="name"/>. Throws
    /// (<c>ERR_BAD_ATTR_VALUE</c>), naming it, when nothing answers it.</summary>
    public static ColumnNamingStrategy Column(string name) =>
        TryGetColumn(name, out var s) ? s : throw new MetaModelException(UnknownMessage("columns", name), ErrorCode.ERR_BAD_ATTR_VALUE);

    /// <summary>The table rule registered as <paramref name="name"/>. Throws, naming it, when nothing answers it.</summary>
    public static TableNamingRule Table(string name) =>
        TryGetTable(name, out var r) ? r : throw new MetaModelException(UnknownMessage("tables", name), ErrorCode.ERR_BAD_ATTR_VALUE);

    /// <summary>
    /// What every port says when a config names a strategy no registered strategy answers:
    /// the same words in every port, with that port's name. <paramref name="key"/> is
    /// <c>columns</c> or <c>tables</c>.
    /// </summary>
    public static string UnknownMessage(string key, string name)
    {
        var columns = key == "columns";
        var builtIns = columns ? BuiltInColumns.Select(s => s.Name).ToList() : BuiltInTables.Select(s => s.Name).ToList();
        var registered = (columns ? Columns.Select(s => s.Name) : Tables.Select(s => s.Name))
            .Where(n => !builtIns.Contains(n)).ToList();
        return $"\"naming.{key}\" names \"{name}\", which no {(columns ? "column" : "table")}-naming strategy registered in the "
            + $"{Port} port answers (built in: {string.Join(", ", builtIns)}; registered by the application: "
            + $"{(registered.Count == 0 ? "none" : string.Join(", ", registered))}). Register it before "
            + ".metaobjects/config.json is read, or correct the name.";
    }

    private static void Validate(string name, Func<string, string> apply, bool isBuiltIn, string kind)
    {
        if (string.IsNullOrEmpty(name)) throw new ArgumentException($"a {kind} strategy needs a non-empty name", nameof(name));
        ArgumentNullException.ThrowIfNull(apply);
        if (isBuiltIn)
            throw new ArgumentException($"\"{name}\" is a built in {kind} strategy and cannot be replaced; register yours under another name", nameof(name));
    }

    private static void Upsert<T>(List<T> list, T item, Func<T, string> nameOf)
    {
        var at = list.FindIndex(x => nameOf(x) == nameOf(item));
        if (at >= 0) list[at] = item; else list.Add(item);
    }
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
    public static string ResolveColumnName(MetaField field) =>
        ResolveColumnName(field, PhysicalNaming.Of(field).Columns);

    /// <summary><see cref="ResolveColumnName(MetaField)"/> under an explicit column rule — for
    /// <c>verify --codegen</c>'s probe of an alternate rule, never a second configured source.</summary>
    public static string ResolveColumnName(MetaField field, ColumnNamingStrategy strategy)
    {
        if (field.DbColumn is { Length: > 0 } explicitColumn) return explicitColumn;
        return strategy.Apply(field.Name);
    }

    /// <summary>
    /// The text before each member's column when <paramref name="field"/> (a <c>field.object
    /// @storage "flattened"</c>) expands its value object into the owning table: its
    /// <c>@flattenedColumnPrefix</c> verbatim (<c>""</c> allowed), else its own resolved column and
    /// <c>_</c>. Core naming, not one generator's: the migration creates these columns and the
    /// generated ORM mappings address them, so every one of them spells them here.
    /// ADR-0039: resolving — <c>@flattenedColumnPrefix</c> and <c>@column</c> may be inherited.
    /// </summary>
    public static string ResolveFlattenedColumnPrefix(MetaField field) =>
        ResolveFlattenedColumnPrefix(field, PhysicalNaming.Of(field).Columns);

    /// <summary><see cref="ResolveFlattenedColumnPrefix(MetaField)"/> under an explicit column rule.</summary>
    public static string ResolveFlattenedColumnPrefix(MetaField field, ColumnNamingStrategy strategy) =>
        field.FlattenedColumnPrefix ?? ResolveColumnName(field, strategy) + "_";

    /// <summary>The column a member of a flattened value object gets in the owning table: the
    /// embedding field's prefix (<see cref="ResolveFlattenedColumnPrefix(MetaField)"/>) followed
    /// by the member's own resolved column.</summary>
    public static string ResolveFlattenedColumnName(MetaField field, MetaField member) =>
        ResolveFlattenedColumnName(field, member, PhysicalNaming.Of(field).Columns);

    /// <summary><see cref="ResolveFlattenedColumnName(MetaField, MetaField)"/> under an explicit column rule.</summary>
    public static string ResolveFlattenedColumnName(MetaField field, MetaField member, ColumnNamingStrategy strategy) =>
        ResolveFlattenedColumnPrefix(field, strategy) + ResolveColumnName(member, strategy);

    /// <summary>The <c>pascal</c> column rule: the first letter upper-cased, the rest
    /// verbatim (one UTF-16 unit in, one out). Not a word split — an acronym keeps the case it
    /// was written in.</summary>
    public static string ToPascalColumn(string name) =>
        name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];

    /// <summary><paramref name="name"/> cased by the table rule — no pluralization (the
    /// caller decides whether to pluralize; see <see cref="MetaSource.PhysicalName"/>).</summary>
    public static string ApplyTableNamingRule(string name, TableNamingRule rule) => rule.Apply(name);
}
