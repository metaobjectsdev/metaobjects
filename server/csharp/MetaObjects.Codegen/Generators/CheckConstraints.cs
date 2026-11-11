// rc.19 item 13 (rulings R55) — the CHECK constraints `meta migrate` derives for a table, with
// its names and its expression text, so the generated EF model declares the same constraints the
// Node migrate path creates: one model, one database, through either delivery path. Ported from
// typescript/packages/migrate-ts/src/expected-schema.ts (buildChecks, validatorCheck,
// crossFieldCheck, withCondition) and check-expression.ts; the shared corpus
// fixtures/check-constraint-conformance/ pins both ports to the same output.
//
// The text is migrate's as written, never Postgres's normalized pg_get_constraintdef form: EF
// compares the text it is given, and migrate already canonicalizes and probes it.

using System.Globalization;
using System.Text.RegularExpressions;
using MetaObjects.Core.Attr;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Validator.ValidatorConstants;
using static MetaObjects.Core.Query.QueryConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>One CHECK constraint: its name and its expression (without the surrounding parentheses).</summary>
public sealed record CheckConstraint(string Name, string Expression);

/// <summary>The CHECK constraints of an entity's table, as <c>meta migrate</c> derives them.</summary>
public static class CheckConstraints
{
    /// <summary>
    /// The dialects a CHECK is declared for: the ones <c>meta migrate</c> builds. Off them (no
    /// <c>migrate.dialect</c>, or <c>mysql</c>) the model declares none, because the expression text
    /// is dialect-specific and EF passes it to the provider verbatim.
    /// </summary>
    public static bool DeclaredFor(string? dialect) => dialect is "postgres" or "sqlite" or "d1";

    private static bool IsSqlite(string? dialect) => dialect is "sqlite" or "d1";

    /// <summary>
    /// The entity's CHECKs, in <c>meta migrate</c>'s order: per field (skipping array columns), its
    /// enum membership and then each validator's; then the entity's cross-field validators. Empty
    /// off a <see cref="DeclaredFor"/> dialect.
    /// </summary>
    public static IReadOnlyList<CheckConstraint> For(MetaObject entity, GenConfig config)
    {
        var dialect = config.Dialect;
        if (!DeclaredFor(dialect)) return [];
        var strategy = config.ColumnNamingStrategy;
        var table = CSharpNaming.Table(entity);
        var checks = new List<CheckConstraint>();
        foreach (var field in entity.Fields())
        {
            // No field-level CHECK on an array column: every expression below is scalar-shaped.
            if (field.ResolvedIsArray()) continue;
            // A derived (origin-bearing) field is no column of the table: a CHECK on it fails the
            // migration. Its validators apply where it is read.
            if (field.IsDerived()) continue;
            var col = CSharpNaming.Column(field, strategy);
            var qcol = Quote(col);
            // @dbCheck: false (resolving) asks for no CHECK: the rule is enforced app-side only.
            if (field.SubType == FIELD_SUBTYPE_ENUM && !OptedOut(field) && field.EffectiveEnumValues is { Count: > 0 } values)
            {
                var ints = field.Attr(FIELD_ATTR_INT_VALUE_MAP) as IReadOnlyDictionary<string, object?>;
                var members = ints is null
                    ? values.Select(Literal)
                    : values.Select(v => ints.TryGetValue(v, out var n) && n is not null
                        ? Number(n)
                        : throw new InvalidOperationException(
                            $"field.enum '{field.Name}' @intValueMap has no integer for member '{v}' — cannot build the CHECK constraint for column '{col}'."));
                checks.Add(Named(new CheckConstraint($"{table}_{col}_chk", $"{qcol} IN ({string.Join(", ", members)})"), field));
            }
            // The VARCHAR(n) the column already is, when the project skips what it enforces. Not on
            // SQLite / D1: they accept a declared length and store longer values anyway.
            var enforcedMax = config.SkipRedundantChecks && !IsSqlite(dialect) ? VarcharLength(field) : null;
            foreach (var v in field.Validators())
            {
                if (OptedOut(v)) continue;
                // A declared @constraintName asks for the CHECK by name, so it is kept even where
                // skipRedundant would leave it out: a declaration beats a default.
                var declared = DeclaredName(v) is not null;
                var check = ValidatorCheck(v, qcol, table, col, dialect,
                    skipRedundant: !declared && config.SkipRedundantChecks, enforcedMax: declared ? null : enforcedMax);
                if (check is not null) checks.Add(Named(check, v));
            }
        }
        foreach (var v in entity.Validators())
        {
            if (OptedOut(v)) continue;
            if (CrossFieldCheck(v, entity, table, strategy, dialect) is { } check)
                checks.Add(Named(WithCondition(check, v, entity, strategy, dialect), v));
        }
        return checks;
    }

    /// <summary>Whether a validator or field.enum opts out of its CHECK (<c>@dbCheck: false</c>, resolving).
    /// <c>SkipRedundantChecks</c> is independent of it: it only ever leaves more out.</summary>
    private static bool OptedOut(MetaData node) => node.Attr(VALIDATOR_ATTR_DB_CHECK) is false;

    /// <summary>The length a string column's <c>VARCHAR(n)</c> enforces: a string's <c>@maxLength</c>, a string-stored enum's resolved length.</summary>
    private static long? VarcharLength(MetaField field) => field.SubType switch
    {
        FIELD_SUBTYPE_STRING => field.Attr(FIELD_ATTR_MAX_LENGTH) is { } m ? Convert.ToInt64(m, CultureInfo.InvariantCulture) : null,
        FIELD_SUBTYPE_ENUM when field.Attr(FIELD_ATTR_INT_VALUE_MAP) is null => EnumLength.ResolveMaxLength(field),
        _ => null,
    };

    private static CheckConstraint? ValidatorCheck(
        MetaValidator v, string qcol, string table, string col, string? dialect, bool skipRedundant, long? enforcedMax)
    {
        switch (v.SubType)
        {
            case VALIDATOR_SUBTYPE_NUMERIC:
            {
                var parts = new List<string>();
                if (v.Attr(VALIDATOR_ATTR_MIN) is { } min) parts.Add($"{qcol} >= {Number(min)}");
                if (v.Attr(VALIDATOR_ATTR_MAX) is { } max) parts.Add($"{qcol} <= {Number(max)}");
                return parts.Count == 0 ? null : new CheckConstraint($"{table}_{col}_numeric_chk", string.Join(" AND ", parts));
            }
            case VALIDATOR_SUBTYPE_LENGTH:
            {
                var parts = new List<string>();
                // Under skipRedundant a minimum of 0 is always true, and a maximum the column's
                // VARCHAR(n) already enforces (n <= max) adds nothing.
                if (v.Attr(VALIDATOR_ATTR_MIN) is { } min && !(skipRedundant && Convert.ToDouble(min, CultureInfo.InvariantCulture) <= 0))
                    parts.Add($"length({qcol}) >= {Number(min)}");
                if (v.Attr(VALIDATOR_ATTR_MAX) is { } max && !(enforcedMax is { } n && n <= Convert.ToDouble(max, CultureInfo.InvariantCulture)))
                    parts.Add($"length({qcol}) <= {Number(max)}");
                return parts.Count == 0 ? null : new CheckConstraint($"{table}_{col}_length_chk", string.Join(" AND ", parts));
            }
            case VALIDATOR_SUBTYPE_REGEX:
                // Postgres-only: SQLite has no native regex operator.
                if (IsSqlite(dialect)) return null;
                return v.Attr(VALIDATOR_ATTR_PATTERN) is string { Length: > 0 } pattern
                    ? new CheckConstraint($"{table}_{col}_regex_chk", $"{qcol} ~ {Literal(pattern)}")
                    : null;
            default:
                return null;
        }
    }

    private static readonly Dictionary<string, string> ComparisonSql = new(StringComparer.Ordinal)
    {
        [FILTER_OP_GT] = ">", [FILTER_OP_GTE] = ">=", [FILTER_OP_LT] = "<", [FILTER_OP_LTE] = "<=", [FILTER_OP_NE] = "<>", [FILTER_OP_EQ] = "=",
    };

    private static string NullSafeDistinct(string? dialect) => IsSqlite(dialect) ? "IS NOT" : "IS DISTINCT FROM";
    private static string NullSafeEqual(string? dialect) => IsSqlite(dialect) ? "IS" : "IS NOT DISTINCT FROM";

    private static (string Qcol, MetaField Field)? Ref(MetaObject entity, object? name, ColumnNamingStrategy strategy)
    {
        if (name is not string { Length: > 0 } n) return null;
        var field = entity.Fields().FirstOrDefault(f => f.Name == n);
        // A derived field has no column, so a cross-field CHECK naming it is skipped like a missing one.
        return field is null || field.IsDerived() ? null : (Quote(CSharpNaming.Column(field, strategy)), field);
    }

    private static CheckConstraint? CrossFieldCheck(MetaValidator v, MetaObject entity, string table, ColumnNamingStrategy strategy, string? dialect)
    {
        switch (v.SubType)
        {
            case VALIDATOR_SUBTYPE_COMPARISON:
            {
                var left = Ref(entity, v.Attr(VALIDATOR_ATTR_LEFT), strategy);
                var right = Ref(entity, v.Attr(VALIDATOR_ATTR_RIGHT), strategy);
                if (left is null || right is null || !ComparisonSql.TryGetValue(v.Attr(VALIDATOR_ATTR_OP)?.ToString() ?? "", out var op)) return null;
                return new CheckConstraint($"{table}_{CSharpNaming.Column(left.Value.Field, strategy)}_cmp_chk", $"{left.Value.Qcol} {op} {right.Value.Qcol}");
            }
            case VALIDATOR_SUBTYPE_REQUIRED_WHEN:
            {
                var target = Ref(entity, v.Attr(VALIDATOR_ATTR_FIELD), strategy);
                var when = Ref(entity, v.Attr(VALIDATOR_ATTR_WHEN), strategy);
                if (target is null || when is null) return null;
                var lit = EqualsLiteral(v.Attr(VALIDATOR_ATTR_EQUALS), when.Value.Field, dialect);
                return new CheckConstraint($"{table}_{CSharpNaming.Column(target.Value.Field, strategy)}_reqwhen_chk",
                    $"({when.Value.Qcol} {NullSafeDistinct(dialect)} {lit}) OR ({target.Value.Qcol} IS NOT NULL)");
            }
            case VALIDATOR_SUBTYPE_PRESENT_IFF:
            {
                var target = Ref(entity, v.Attr(VALIDATOR_ATTR_FIELD), strategy);
                var when = Ref(entity, v.Attr(VALIDATOR_ATTR_WHEN), strategy);
                if (target is null || when is null) return null;
                var lit = EqualsLiteral(v.Attr(VALIDATOR_ATTR_EQUALS), when.Value.Field, dialect);
                return new CheckConstraint($"{table}_{CSharpNaming.Column(target.Value.Field, strategy)}_presentiff_chk",
                    $"({target.Value.Qcol} IS NOT NULL) = ({when.Value.Qcol} {NullSafeEqual(dialect)} {lit})");
            }
            case VALIDATOR_SUBTYPE_AT_LEAST_ONE:
            {
                var raw = v.Attr(VALIDATOR_ATTR_FIELDS);
                IReadOnlyList<object?> names = raw switch
                {
                    IEnumerable<object?> list when raw is not string => list.ToList(),
                    string s => [s],
                    _ => [],
                };
                var refs = names.Select(n => Ref(entity, n, strategy)).ToList();
                if (refs.Count == 0 || refs.Any(r => r is null)) return null;
                var name = $"{table}_{CSharpNaming.Column(refs[0]!.Value.Field, strategy)}_atleastone_chk";
                // @max bounds how many may be present (@max 1: exactly one). Postgres counts them
                // with num_nonnulls; SQLite adds the presence tests, which it evaluates as 0 / 1.
                if (v.Attr(VALIDATOR_ATTR_MAX) is { } maxRaw && IsNumber(maxRaw))
                {
                    var count = IsSqlite(dialect)
                        ? $"({string.Join(" + ", refs.Select(r => $"({r!.Value.Qcol} IS NOT NULL)"))})"
                        : $"num_nonnulls({string.Join(", ", refs.Select(r => r!.Value.Qcol))})";
                    var max = Number(maxRaw);
                    // Two comparisons, not BETWEEN: Postgres stores a BETWEEN as these two.
                    return new CheckConstraint(name, max == "1" ? $"{count} = 1" : $"{count} >= 1 AND {count} <= {max}");
                }
                return new CheckConstraint(name, string.Join(" OR ", refs.Select(r => $"{r!.Value.Qcol} IS NOT NULL")));
            }
            default:
                return null;
        }
    }

    /// <summary>
    /// A cross-field validator's <c>@condition</c>: the rule applies only when it holds, so the
    /// CHECK is the negated condition OR the rule.
    /// </summary>
    private static CheckConstraint WithCondition(CheckConstraint check, MetaValidator v, MetaObject entity, ColumnNamingStrategy strategy, string? dialect)
    {
        if (v.Attr(VALIDATOR_ATTR_CONDITION) is not IReadOnlyDictionary<string, object?> condition) return check;
        string? Column(string name) =>
            entity.Fields().FirstOrDefault(f => f.Name == name) is { } f ? Quote(CSharpNaming.Column(f, strategy)) : null;
        // An int-backed enum stores a member as its integer; a duration in the form its column stores.
        string? Stored(string name, object? value)
        {
            var field = entity.Fields().FirstOrDefault(f => f.Name == name);
            if (field?.SubType == FIELD_SUBTYPE_DURATION) return DurationLiteral(field, value, dialect, "@condition");
            return field?.Attr(FIELD_ATTR_INT_VALUE_MAP) is IReadOnlyDictionary<string, object?> ints
                   && value is string s && ints.TryGetValue(s, out var n) && n is not null && IsNumber(n)
                ? Number(n)
                : null;
        }
        var unless = Render(Negate(condition), Column, dialect, Stored);
        return check with { Expression = $"({unless}) OR ({check.Expression})" };
    }

    private static CheckConstraint Named(CheckConstraint check, MetaData node) =>
        DeclaredName(node) is { } name ? check with { Name = name } : check;

    private static string? DeclaredName(MetaData node) =>
        node.Attr(VALIDATOR_ATTR_CONSTRAINT_NAME) is string { Length: > 0 } name ? name : null;

    /// <summary>
    /// An <c>@equals</c> gating value as a SQL literal, typed by the gating field: a boolean is
    /// TRUE/FALSE (1/0 on SQLite/D1), a numeric is bare, a duration is the form its column stores,
    /// anything else is a quoted string.
    /// </summary>
    private static string EqualsLiteral(object? raw, MetaField when, string? dialect)
    {
        if (when.SubType == FIELD_SUBTYPE_DURATION) return DurationLiteral(when, raw, dialect, "@equals");
        var s = raw switch
        {
            bool b => b ? "true" : "false",
            null => "",
            _ => Convert.ToString(raw, CultureInfo.InvariantCulture) ?? "",
        };
        if (when.SubType == FIELD_SUBTYPE_BOOLEAN)
        {
            var truthy = s is "true" or "1" or "TRUE";
            return IsSqlite(dialect) ? (truthy ? "1" : "0") : (truthy ? "TRUE" : "FALSE");
        }
        var numeric = when.SubType is FIELD_SUBTYPE_INT or FIELD_SUBTYPE_LONG or FIELD_SUBTYPE_DOUBLE
            or FIELD_SUBTYPE_FLOAT or FIELD_SUBTYPE_DECIMAL or FIELD_SUBTYPE_CURRENCY;
        if (numeric && Regex.IsMatch(s, @"^-?\d+(\.\d+)?$")) return s;
        return Literal(s);
    }

    // ---- field.duration literals (typescript metadata duration-wire.ts) ----

    private static readonly Regex DurationForm = new(@"^[-+]?P(?!$)(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$");
    private static readonly Regex DurationParts = new(@"^([-+])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d+))?S)?)?$");
    private const long MicrosPerSecond = 1_000_000L, MicrosPerMinute = 60 * MicrosPerSecond, MicrosPerHour = 60 * MicrosPerMinute, MicrosPerDay = 24 * MicrosPerHour;

    /// <summary>A literal compared with a duration column, in the form the column stores: the
    /// interval spelling on Postgres, the microsecond integer on SQLite and D1.</summary>
    private static string DurationLiteral(MetaField field, object? raw, string? dialect, string where)
    {
        if (raw is not string text || ParseDuration(text) is not { } micros)
            throw new InvalidOperationException(
                $"{where} compares field.duration '{field.Name}' with {System.Text.Json.JsonSerializer.Serialize(raw)}, which is not an ISO-8601 " +
                "duration (such as PT1H30M; no years or months) — cannot build the CHECK.");
        if (IsSqlite(dialect)) return micros.ToString(CultureInfo.InvariantCulture);
        return Literal(PostgresInterval(micros));
    }

    private static long? ParseDuration(string text)
    {
        if (!DurationForm.IsMatch(text)) return null;
        var m = DurationParts.Match(text);
        if (!m.Success) return null;
        long Part(int i) => m.Groups[i].Success ? long.Parse(m.Groups[i].Value, CultureInfo.InvariantCulture) : 0;
        var fraction = m.Groups[7].Success ? long.Parse(m.Groups[7].Value.PadRight(6, '0')[..6], CultureInfo.InvariantCulture) : 0;
        var magnitude = Part(2) * 7 * MicrosPerDay + Part(3) * MicrosPerDay + Part(4) * MicrosPerHour
                        + Part(5) * MicrosPerMinute + Part(6) * MicrosPerSecond + fraction;
        return m.Groups[1].Value == "-" ? -magnitude : magnitude;
    }

    private static string PostgresInterval(long micros)
    {
        var negative = micros < 0;
        var rest = Math.Abs(micros);
        var h = rest / MicrosPerHour; rest %= MicrosPerHour;
        var min = rest / MicrosPerMinute; rest %= MicrosPerMinute;
        var s = rest / MicrosPerSecond;
        var frac = rest % MicrosPerSecond;
        var output = $"{h:00}:{min:00}:{s:00}";
        if (frac > 0) output += "." + frac.ToString("000000", CultureInfo.InvariantCulture).TrimEnd('0');
        return negative && micros != 0 ? "-" + output : output;
    }

    // ---- the @condition expression (typescript migrate-ts check-expression.ts) ----

    private static readonly Dictionary<string, string> NegatedOp = new(StringComparer.Ordinal)
    {
        [FILTER_OP_EQ] = FILTER_OP_NE, [FILTER_OP_NE] = FILTER_OP_EQ,
        [FILTER_OP_GT] = FILTER_OP_LTE, [FILTER_OP_LTE] = FILTER_OP_GT,
        [FILTER_OP_LT] = FILTER_OP_GTE, [FILTER_OP_GTE] = FILTER_OP_LT,
        [FILTER_OP_IS_NULL] = ExpressionGrammar.EXPR_OP_IS_NOT_NULL, [ExpressionGrammar.EXPR_OP_IS_NOT_NULL] = FILTER_OP_IS_NULL,
    };

    private const string KeyField = "field", KeyValue = "value", KeyFn = "fn", KeyOp = "op", KeyLeft = "left", KeyRight = "right", KeyArg = "arg", KeyArgs = "args";

    private static IReadOnlyDictionary<string, object?> Negate(IReadOnlyDictionary<string, object?> n)
    {
        var op = n.TryGetValue(KeyOp, out var o) ? o as string : null;
        if (op == ExpressionGrammar.EXPR_OP_NOT) return (IReadOnlyDictionary<string, object?>)n[KeyArg]!;
        if (op is FILTER_COMPOSE_AND or FILTER_COMPOSE_OR)
            return new Dictionary<string, object?>
            {
                [KeyOp] = op == FILTER_COMPOSE_AND ? FILTER_COMPOSE_OR : FILTER_COMPOSE_AND,
                [KeyArgs] = Args(n).Select(a => (object?)Negate(a)).ToList(),
            };
        if (op is not null && NegatedOp.TryGetValue(op, out var flipped))
            return new Dictionary<string, object?>(n) { [KeyOp] = flipped };
        return new Dictionary<string, object?> { [KeyOp] = ExpressionGrammar.EXPR_OP_NOT, [KeyArg] = n };
    }

    private static IEnumerable<IReadOnlyDictionary<string, object?>> Args(IReadOnlyDictionary<string, object?> n) =>
        n.TryGetValue(KeyArgs, out var a) && a is IEnumerable<object?> list
            ? list.Cast<IReadOnlyDictionary<string, object?>>()
            : [];

    private static bool IsAtom(IReadOnlyDictionary<string, object?> n) =>
        n.TryGetValue(KeyField, out var f) && f is string || n.ContainsKey(KeyValue) || n.TryGetValue(KeyFn, out var fn) && fn is not null;

    private static string Render(
        IReadOnlyDictionary<string, object?> n, Func<string, string?> column, string? dialect, Func<string, object?, string?> stored)
    {
        if (n.TryGetValue(KeyField, out var fieldRaw) && fieldRaw is string field)
            return column(field) ?? throw new InvalidOperationException($"@condition names \"{field}\", which is not a field of the entity");
        if (n.TryGetValue(KeyValue, out var value)) return ConditionLiteral(value, dialect);
        string Sub(object? x) => Render((IReadOnlyDictionary<string, object?>)x!, column, dialect, stored);
        string Operand(object? x, object? other)
        {
            var node = (IReadOnlyDictionary<string, object?>)x!;
            if (node.TryGetValue(KeyValue, out var v) && StoredFieldOf(other) is { } f && stored(f, v) is { } sql) return sql;
            return IsAtom(node) ? Sub(x) : $"({Sub(x)})";
        }
        var op = n.TryGetValue(KeyOp, out var o) ? o as string : null;
        if (op is not null && ComparisonSql.TryGetValue(op, out var sqlOp))
            return $"{Operand(n[KeyLeft], n[KeyRight])} {sqlOp} {Operand(n[KeyRight], n[KeyLeft])}";
        if (op == FILTER_OP_IS_NULL) return $"{Operand(n[KeyArg], null)} IS NULL";
        if (op == ExpressionGrammar.EXPR_OP_IS_NOT_NULL) return $"{Operand(n[KeyArg], null)} IS NOT NULL";
        if (op == ExpressionGrammar.EXPR_OP_NOT) return $"NOT ({Sub(n[KeyArg])})";
        if (op is FILTER_COMPOSE_AND or FILTER_COMPOSE_OR)
            return string.Join(op == FILTER_COMPOSE_AND ? " AND " : " OR ", Args(n).Select(a => $"({Sub(a)})"));
        if (n.TryGetValue(KeyFn, out var fn) && fn as string == ExpressionGrammar.EXPR_FN_COALESCE)
            return $"COALESCE({string.Join(", ", Args(n).Select(a => Sub(a)))})";
        throw new InvalidOperationException($"@condition: an expression node a CHECK cannot render: {System.Text.Json.JsonSerializer.Serialize(n)}");
    }

    /// <summary>The field whose column form a literal compared with <paramref name="node"/> takes.</summary>
    private static string? StoredFieldOf(object? node)
    {
        if (node is not IReadOnlyDictionary<string, object?> n) return null;
        if (n.TryGetValue(KeyField, out var f) && f is string s) return s;
        if (n.TryGetValue(KeyFn, out var fn) && fn as string == ExpressionGrammar.EXPR_FN_COALESCE)
            foreach (var a in Args(n))
                if (StoredFieldOf(a) is { } found) return found;
        return null;
    }

    private static string ConditionLiteral(object? v, string? dialect) => v switch
    {
        null => "NULL",
        bool b => IsSqlite(dialect) ? (b ? "1" : "0") : (b ? "TRUE" : "FALSE"),
        _ when IsNumber(v) => Number(v),
        _ => Literal(Convert.ToString(v, CultureInfo.InvariantCulture) ?? ""),
    };

    // ---- spelling ----

    /// <summary>A column in a CHECK, double-quoted (both dialects quote that way; a bare mixed-case name folds).</summary>
    private static string Quote(string col) => "\"" + col.Replace("\"", "\"\"") + "\"";

    private static string Literal(string s) => "'" + s.Replace("'", "''") + "'";

    private static bool IsNumber(object v) => v is sbyte or byte or short or ushort or int or uint or long or ulong or float or double or decimal;

    private static string Number(object v) => v switch
    {
        double d => d.ToString("R", CultureInfo.InvariantCulture),
        float f => f.ToString("R", CultureInfo.InvariantCulture),
        _ => Convert.ToString(v, CultureInfo.InvariantCulture)!,
    };
}
