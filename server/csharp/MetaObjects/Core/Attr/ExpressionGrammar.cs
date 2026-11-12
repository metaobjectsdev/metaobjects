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
    // `case` ({ case: [ { when, then } ], else?, operand? }) and `now` ({ now, startOf? }).
    public const string EXPR_CASE           = "case";
    public const string EXPR_CASE_WHEN      = "when";
    public const string EXPR_CASE_THEN      = "then";
    public const string EXPR_CASE_ELSE      = "else";
    public const string EXPR_CASE_OPERAND   = "operand";
    public const string EXPR_NOW            = "now";
    public const string EXPR_NOW_START_OF   = "startOf";

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

    /// <summary>Each node kind (keyed by the key that names it) and the only keys it may carry.</summary>
    private static readonly (string Kind, string[] Keys)[] NodeKeys =
    [
        (KEY_FIELD, [KEY_FIELD]),
        (KEY_VALUE, [KEY_VALUE]),
        (EXPR_NOW, [EXPR_NOW, EXPR_NOW_START_OF]),
        (EXPR_CASE, [EXPR_CASE, EXPR_CASE_ELSE, EXPR_CASE_OPERAND]),
        (KEY_FN, [KEY_FN, KEY_ARGS]),
        (KEY_OP, [KEY_OP, KEY_LEFT, KEY_RIGHT, KEY_ARG, KEY_ARGS]),
    ];

    private static readonly HashSet<string> NumericSubtypes = new(StringComparer.Ordinal)
    {
        FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_CURRENCY,
    };

    /// <summary>The field names an expression tree references, in order of appearance.</summary>
    public static List<string> FieldRefs(object? node)
        => Nodes(node).Select(n => Get(n, KEY_FIELD)).OfType<string>().ToList();

    /// <summary>Every node of an expression tree, root first.</summary>
    public static List<IReadOnlyDictionary<string, object?>> Nodes(object? node)
    {
        var nodes = new List<IReadOnlyDictionary<string, object?>>();
        void Walk(object? x)
        {
            if (x is not IReadOnlyDictionary<string, object?> n) return;
            nodes.Add(n);
            Walk(Get(n, KEY_LEFT));
            Walk(Get(n, KEY_RIGHT));
            Walk(Get(n, KEY_ARG));
            if (Get(n, KEY_ARGS) is IEnumerable<object?> args) foreach (var a in args) Walk(a);
            Walk(Get(n, EXPR_CASE_OPERAND));
            Walk(Get(n, EXPR_CASE_ELSE));
            if (Get(n, EXPR_CASE) is IEnumerable<object?> arms)
                foreach (var arm in arms)
                    if (arm is IReadOnlyDictionary<string, object?> a) { Walk(Get(a, EXPR_CASE_WHEN)); Walk(Get(a, EXPR_CASE_THEN)); }
        }
        Walk(node);
        return nodes;
    }

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

        var nodeKind = NodeKeys.FirstOrDefault(k => n.ContainsKey(k.Kind));
        if (nodeKind.Kind is not null)
        {
            var extraKeys = n.Keys.Where(k => !nodeKind.Keys.Contains(k)).ToList();
            if (extraKeys.Count > 0)
                return [$"expression '{nodeKind.Kind}' node takes only {string.Join(", ", nodeKind.Keys)}, not {string.Join(", ", extraKeys)}"];
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

        if (n.ContainsKey(EXPR_NOW))
        {
            if (Get(n, EXPR_NOW) is not string duration || !ISO_DURATION_RE.IsMatch(duration))
                return [$"expression '{EXPR_NOW}' must be an ISO-8601 duration string (e.g. '-P7D'), got {Str(Get(n, EXPR_NOW))}"];
            return n.ContainsKey(EXPR_NOW_START_OF) && (Get(n, EXPR_NOW_START_OF) is not string unit || !RELATIVE_START_OF_UNITS.Contains(unit))
                ? [$"expression '{EXPR_NOW_START_OF}' must be one of {string.Join(", ", RELATIVE_START_OF_UNITS)}, got {Str(Get(n, EXPR_NOW_START_OF))}"]
                : [];
        }

        if (n.ContainsKey(EXPR_CASE))
        {
            if (Get(n, EXPR_CASE) is not IReadOnlyList<object?> arms || arms.Count == 0)
                return [$"'{EXPR_CASE}' requires a non-empty array of {{ {EXPR_CASE_WHEN}, {EXPR_CASE_THEN} }} arms"];
            var errs = new List<string>();
            foreach (var arm in arms)
            {
                if (arm is not IReadOnlyDictionary<string, object?> a || !a.ContainsKey(EXPR_CASE_WHEN) || !a.ContainsKey(EXPR_CASE_THEN)
                    || a.Keys.Any(k => k != EXPR_CASE_WHEN && k != EXPR_CASE_THEN))
                {
                    errs.Add($"every '{EXPR_CASE}' arm must be {{ {EXPR_CASE_WHEN}, {EXPR_CASE_THEN} }}");
                    continue;
                }
                errs.AddRange(ValidateExprNode(Get(a, EXPR_CASE_WHEN)));
                errs.AddRange(ValidateExprNode(Get(a, EXPR_CASE_THEN)));
            }
            if (n.ContainsKey(EXPR_CASE_ELSE)) errs.AddRange(ValidateExprNode(Get(n, EXPR_CASE_ELSE)));
            if (n.ContainsKey(EXPR_CASE_OPERAND)) errs.AddRange(ValidateExprNode(Get(n, EXPR_CASE_OPERAND)));
            return errs;
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

        return ["expression node must be one of {field}, {value}, {op,…}, {fn,…}, {case,…}, {now}"];
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
                ? new InferResult(null, [$"expression field '{name}' does not resolve to a projection field (not an aggregate) or a base entity field"])
                : new InferResult(t, []);
        }

        if (n.ContainsKey(KEY_VALUE))
            return new InferResult(LiteralType(Get(n, KEY_VALUE)), []);

        // now: an instant; compared with a date or local timestamp it takes that kind at lowering.
        if (n.ContainsKey(EXPR_NOW))
            return new InferResult(FIELD_SUBTYPE_TIMESTAMP, []);

        if (n.ContainsKey(EXPR_CASE))
        {
            var errors = new List<string>();
            var arms = (IReadOnlyList<object?>)Get(n, EXPR_CASE)!;
            InferResult? operand = n.ContainsKey(EXPR_CASE_OPERAND) ? InferExprType(Get(n, EXPR_CASE_OPERAND), resolveField) : null;
            if (operand is { } o) errors.AddRange(o.Errors);
            var results = new List<string?>();
            var resultNodes = new List<object?>();
            foreach (var armObj in arms)
            {
                var arm = (IReadOnlyDictionary<string, object?>)armObj!;
                var w = InferExprType(Get(arm, EXPR_CASE_WHEN), resolveField);
                errors.AddRange(w.Errors);
                if (operand is null && w.Type is not null && w.Type != FIELD_SUBTYPE_BOOLEAN)
                    errors.Add($"a searched '{EXPR_CASE}' needs a boolean '{EXPR_CASE_WHEN}', got {w.Type}");
                if (operand is { Type: { } ot } && w.Type is not null && Get(arm, EXPR_CASE_WHEN) is IReadOnlyDictionary<string, object?> wn
                    && !wn.ContainsKey(KEY_VALUE) && w.Type != ot)
                    errors.Add($"a simple '{EXPR_CASE}' compares its {ot} '{EXPR_CASE_OPERAND}' with a {w.Type} '{EXPR_CASE_WHEN}'");
                var t = InferExprType(Get(arm, EXPR_CASE_THEN), resolveField);
                errors.AddRange(t.Errors);
                results.Add(t.Type);
                resultNodes.Add(Get(arm, EXPR_CASE_THEN));
            }
            if (n.ContainsKey(EXPR_CASE_ELSE))
            {
                var e = InferExprType(Get(n, EXPR_CASE_ELSE), resolveField);
                errors.AddRange(e.Errors);
                results.Add(e.Type);
                resultNodes.Add(Get(n, EXPR_CASE_ELSE));
            }
            var (unified, differing) = UnifyTypes(resultNodes, results);
            if (differing is not null)
                errors.Add($"'{EXPR_CASE}' results have differing types ({string.Join(", ", differing)})");
            return new InferResult(unified, errors);
        }

        if (n.ContainsKey(KEY_FN)) // coalesce
        {
            var args = (IReadOnlyList<object?>)Get(n, KEY_ARGS)!;
            var argResults = args.Select(a => InferExprType(a, resolveField)).ToList();
            var errors = argResults.SelectMany(a => a.Errors).ToList();
            var (unified, differing) = UnifyTypes(args, argResults.Select(a => a.Type).ToList());
            if (differing is not null)
                errors.Add($"'{EXPR_FN_COALESCE}' arguments have differing types ({string.Join(", ", differing)})");
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

    /// <summary>A numeric literal or a <c>now</c> node: it takes the type of the result it sits beside.</summary>
    private static bool IsAdaptable(object? node) =>
        node is IReadOnlyDictionary<string, object?> n
        && ((n.ContainsKey(KEY_VALUE) && Get(n, KEY_VALUE) is long or int or double) || n.ContainsKey(EXPR_NOW));

    /// <summary>Whether an adaptable node takes <paramref name="to"/>: a number takes any numeric
    /// type, <c>now</c> a date or timestamp.</summary>
    private static bool AdaptsTo(object? node, string to) =>
        node is IReadOnlyDictionary<string, object?> n && n.ContainsKey(EXPR_NOW)
            ? to == FIELD_SUBTYPE_DATE || to == FIELD_SUBTYPE_TIMESTAMP
            : NumericSubtypes.Contains(to);

    /// <summary>The one type of a case's results or a coalesce's args, or every type when they do not unify.</summary>
    private static (string? Type, List<string>? Differing) UnifyTypes(IReadOnlyList<object?> nodes, IReadOnlyList<string?> types)
    {
        var typed = nodes.Zip(types).Where(r => r.Second is not null).Select(r => (Node: r.First, Type: r.Second!)).ToList();
        var anchor = typed.FirstOrDefault(r => !IsAdaptable(r.Node));
        string? unified = anchor.Type ?? (typed.Count > 0 ? typed[0].Type : null);
        bool fits = typed.All(r => r.Type == unified
            || (anchor.Type is not null && IsAdaptable(r.Node) && AdaptsTo(r.Node, anchor.Type)));
        return fits ? (unified, null) : (unified, typed.Select(r => r.Type).Distinct().ToList());
    }

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
