// attr.expression — the closed structured-expression node grammar backing
// origin.computed (#195). A row-level value computed from a base entity's own
// fields. Deliberately NOT a raw-SQL string: a declarative, backend-agnostic
// tree that any lowering (SQL view DDL, an in-process evaluator, a document
// store) can walk.
//
// Ported 1:1 from typescript/packages/metadata/src/core/attr/meta-attr-expression.ts
// (validateExprNode + inferExprType + literalType). The C# port stores @expr
// verbatim as an IReadOnlyDictionary tree (DataConverter.ToAttrObject) — the attr
// class only checks shape (DataType.Object) — so the CLOSED node grammar and the
// entity-aware type inference run in the origin.computed validation pass
// (ValidationPasses.ValidateOriginPaths), NOT the attr class. That keeps every
// port validating the closed grammar identically (the cross-port contract: TS/C#/
// Java/Python/Kotlin all store @expr verbatim). It shares the FILTER op vocabulary
// and per-subtype legality bands (QueryConstants) so the two languages stay ONE
// vocabulary.

namespace MetaObjects.Core.Attr;

/// <summary>
/// #195 — the closed structured-expression node grammar backing origin.computed.
/// Structural well-formedness (<see cref="ValidateExprNode"/>) and entity-aware
/// type inference (<see cref="InferExprType"/>) are pure functions; the loader's
/// origin pass calls them and maps their string diagnostics to the stable codes
/// (ERR_UNKNOWN_EXPR_NODE / ERR_INVALID_ORIGIN / ERR_COMPUTED_TYPE_MISMATCH).
/// </summary>
public static class ExpressionGrammar
{
    // Expression-only op/fn names — the comparison + and/or/isNull names are the
    // shared filter vocabulary (QueryConstants); these three are new.
    public const string EXPR_OP_IS_NOT_NULL = "isNotNull";
    public const string EXPR_OP_NOT         = "not";
    public const string EXPR_FN_COALESCE    = "coalesce";

    // Node-kind keys (verbatim from the @expr tree — not metamodel attrs).
    private const string KEY_FIELD = "field";
    private const string KEY_VALUE = "value";
    private const string KEY_FN    = "fn";
    private const string KEY_OP    = "op";
    private const string KEY_LEFT  = "left";
    private const string KEY_RIGHT = "right";
    private const string KEY_ARG   = "arg";
    private const string KEY_ARGS  = "args";

    private static readonly HashSet<string> ComparisonOps = new(StringComparer.Ordinal)
    {
        FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE,
    };

    private static readonly HashSet<string> NullOps = new(StringComparer.Ordinal)
    {
        FILTER_OP_IS_NULL, EXPR_OP_IS_NOT_NULL,
    };

    private static readonly HashSet<string> VariadicLogicOps = new(StringComparer.Ordinal)
    {
        FILTER_COMPOSE_AND, FILTER_COMPOSE_OR,
    };

    // -------------------------------------------------------------------------
    // Structural validation — known node kinds, ops, arity. No entity/type
    // context (see InferExprType for typing). Returns [] when valid.
    // -------------------------------------------------------------------------

    /// <summary>
    /// Structural well-formedness of an expression tree (known node kinds, ops,
    /// arity). Returns an empty list when valid. Mirrors TS <c>validateExprNode</c>.
    /// </summary>
    public static List<string> ValidateExprNode(object? node)
    {
        if (node is not IReadOnlyDictionary<string, object?> n)
        {
            string kind = node is null
                ? "null"
                : node is System.Collections.IEnumerable && node is not string ? "array" : RuntimeType(node);
            return [$"expression node must be an object, got {kind}"];
        }

        if (n.ContainsKey(KEY_FIELD))
        {
            return Get(n, KEY_FIELD) is string fs && fs.Length > 0
                ? []
                : ["expression 'field' must be a non-empty string"];
        }

        if (n.ContainsKey(KEY_VALUE))
        {
            return IsScalarLiteral(Get(n, KEY_VALUE))
                ? []
                : ["expression 'value' must be a scalar literal (string/number/boolean/null)"];
        }

        if (n.ContainsKey(KEY_FN))
        {
            if (Get(n, KEY_FN) is not string fn || fn != EXPR_FN_COALESCE)
                return [$"unknown expression fn '{Str(Get(n, KEY_FN))}'"];
            return Get(n, KEY_ARGS) is IReadOnlyList<object?> args && args.Count >= 1
                ? args.SelectMany(ValidateExprNode).ToList()
                : [$"'{EXPR_FN_COALESCE}' requires a non-empty args array"];
        }

        if (n.ContainsKey(KEY_OP))
        {
            if (Get(n, KEY_OP) is not string op)
                return ["expression 'op' must be a string"];
            if (ComparisonOps.Contains(op))
            {
                return n.ContainsKey(KEY_LEFT) && n.ContainsKey(KEY_RIGHT)
                    ? [.. ValidateExprNode(Get(n, KEY_LEFT)), .. ValidateExprNode(Get(n, KEY_RIGHT))]
                    : [$"comparison op '{op}' requires 'left' and 'right'"];
            }
            if (NullOps.Contains(op) || op == EXPR_OP_NOT)
            {
                return n.ContainsKey(KEY_ARG)
                    ? ValidateExprNode(Get(n, KEY_ARG))
                    : [$"op '{op}' requires 'arg'"];
            }
            if (VariadicLogicOps.Contains(op))
            {
                return Get(n, KEY_ARGS) is IReadOnlyList<object?> a && a.Count >= 1
                    ? a.SelectMany(ValidateExprNode).ToList()
                    : [$"op '{op}' requires a non-empty args array"];
            }
            return [$"unknown expression op '{op}'"];
        }

        return ["expression node must be one of {field}, {value}, {op,…}, {fn,…}"];
    }

    // -------------------------------------------------------------------------
    // Type inference — bottom-up, against a base entity's fields.
    // -------------------------------------------------------------------------

    /// <summary>The inferred root subType (or null when untypable) plus any errors.</summary>
    public readonly record struct InferResult(string? Type, IReadOnlyList<string> Errors);

    /// <summary>
    /// Bottom-up type inference for a computed expression. <paramref name="resolveField"/>
    /// returns the subType of a base-entity field ref (null = unresolvable).
    /// Comparisons / null-tests / logic → boolean; a field ref → its subType;
    /// coalesce → the unified arg subType. Also enforces per-operand op legality
    /// against the shared filter bands. Mirrors TS <c>inferExprType</c>.
    /// </summary>
    public static InferResult InferExprType(object? node, Func<string, string?> resolveField)
    {
        var structural = ValidateExprNode(node);
        if (structural.Count > 0) return new InferResult(null, structural);
        var n = (IReadOnlyDictionary<string, object?>)node!;

        if (n.ContainsKey(KEY_FIELD))
        {
            var name = (string)Get(n, KEY_FIELD)!;
            var t = resolveField(name);
            return t is null
                ? new InferResult(null, [$"expression field '{name}' does not resolve to a base entity field"])
                : new InferResult(t, []);
        }

        if (n.ContainsKey(KEY_VALUE))
            return new InferResult(LiteralType(Get(n, KEY_VALUE)), []);

        if (n.ContainsKey(KEY_FN)) // coalesce
        {
            var args = (IReadOnlyList<object?>)Get(n, KEY_ARGS)!;
            var argResults = args.Select(a => InferExprType(a, resolveField)).ToList();
            var errors = argResults.SelectMany(a => a.Errors).ToList();
            var argTypes = argResults.Select(a => a.Type).Where(t => t is not null).Select(t => t!).ToList();
            string? unified = argTypes.Count > 0 ? argTypes[0] : null;
            if (unified is not null && argTypes.Any(t => t != unified))
                errors.Add($"'{EXPR_FN_COALESCE}' arguments have differing types ({string.Join(", ", argTypes.Distinct())})");
            return new InferResult(unified, errors);
        }

        var op = (string)Get(n, KEY_OP)!;
        if (ComparisonOps.Contains(op))
        {
            var l = InferExprType(Get(n, KEY_LEFT), resolveField);
            var r = InferExprType(Get(n, KEY_RIGHT), resolveField);
            var errors = l.Errors.Concat(r.Errors).ToList();
            if (l.Type is not null && !OpsForSubType(l.Type).Contains(op))
                errors.Add($"op '{op}' is not legal for a {l.Type} operand");
            return new InferResult(FIELD_SUBTYPE_BOOLEAN, errors);
        }
        if (NullOps.Contains(op))
            return new InferResult(FIELD_SUBTYPE_BOOLEAN, InferExprType(Get(n, KEY_ARG), resolveField).Errors.ToList());
        if (op == EXPR_OP_NOT || VariadicLogicOps.Contains(op))
        {
            var kids = op == EXPR_OP_NOT
                ? new List<object?> { Get(n, KEY_ARG) }
                : ((IReadOnlyList<object?>)Get(n, KEY_ARGS)!).ToList();
            var errors = new List<string>();
            foreach (var k in kids)
            {
                var kt = InferExprType(k, resolveField);
                errors.AddRange(kt.Errors);
                if (kt.Type is not null && kt.Type != FIELD_SUBTYPE_BOOLEAN)
                    errors.Add($"op '{op}' requires boolean operands, got {kt.Type}");
            }
            return new InferResult(FIELD_SUBTYPE_BOOLEAN, errors);
        }
        return new InferResult(null, [$"unknown expression op '{op}'"]);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static object? Get(IReadOnlyDictionary<string, object?> n, string key)
        => n.TryGetValue(key, out var v) ? v : null;

    /// <summary>A scalar literal (string / number / boolean / null). Numbers arrive
    /// as long or double from DataConverter.ParseNumber.</summary>
    private static bool IsScalarLiteral(object? v)
        => v is null || v is string || v is bool || v is long || v is int || v is double;

    /// <summary>The subType of a scalar literal (coarse: integer number → int, else
    /// double). Mirrors TS <c>literalType</c> (which uses <c>Number.isInteger</c>).</summary>
    private static string? LiteralType(object? v)
    {
        if (v is string) return FIELD_SUBTYPE_STRING;
        if (v is bool) return FIELD_SUBTYPE_BOOLEAN;
        if (v is long or int) return FIELD_SUBTYPE_INT;
        if (v is double d) return (d == Math.Floor(d) && !double.IsInfinity(d)) ? FIELD_SUBTYPE_INT : FIELD_SUBTYPE_DOUBLE;
        return null; // null literal
    }

    private static string Str(object? v) => v?.ToString() ?? "null";

    private static string RuntimeType(object v) => v switch
    {
        string => "string",
        bool   => "boolean",
        long or int or double => "number",
        _      => v.GetType().Name,
    };
}
