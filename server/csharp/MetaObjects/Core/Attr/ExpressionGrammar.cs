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
    // rc.19 `case` ({ case: [ { when, then } ], else?, operand? }) and `now` ({ now, startOf? }).
    public const string EXPR_CASE           = "case";
    public const string EXPR_CASE_WHEN      = "when";
    public const string EXPR_CASE_THEN      = "then";
    public const string EXPR_CASE_ELSE      = "else";
    public const string EXPR_CASE_OPERAND   = "operand";
    public const string EXPR_NOW            = "now";
    public const string EXPR_NOW_START_OF   = "startOf";
    // rc.21 part B (U12): { cast: <expr>, as: "<field subtype>", dbColumnType?: "<text spelling>" }.
    public const string EXPR_CAST                = "cast";
    public const string EXPR_CAST_AS             = "as";
    public const string EXPR_CAST_DB_COLUMN_TYPE = "dbColumnType";

    /// <summary>A function parameter's kind: a string, an integer, any scalar, or the type the "same" ones share.</summary>
    private enum ParamKind { String, Int, Scalar, Same }
    /// <summary>One function's signature: arity, each parameter's kind (the last repeats) and the result.</summary>
    private sealed record FnSignature(int Min, int Max, ParamKind[] Params, string Result, bool Ordered = false);

    /// <summary>
    /// rc.21 part B (U11, U13): the closed, typed function set beside coalesce, by name — the TS
    /// <c>EXPR_FUNCTIONS</c> table, entry for entry. Never free SQL.
    /// </summary>
    private static readonly Dictionary<string, FnSignature> Functions = new(StringComparer.Ordinal)
    {
        [EXPR_FN_COALESCE] = new(1, int.MaxValue, [ParamKind.Same], "same"),
        ["greatest"] = new(1, int.MaxValue, [ParamKind.Same], "same", Ordered: true),
        ["least"] = new(1, int.MaxValue, [ParamKind.Same], "same", Ordered: true),
        ["nullif"] = new(2, 2, [ParamKind.Same, ParamKind.Same], "same"),
        ["lower"] = new(1, 1, [ParamKind.String], "string"),
        ["upper"] = new(1, 1, [ParamKind.String], "string"),
        ["btrim"] = new(1, 2, [ParamKind.String, ParamKind.String], "string"),
        ["splitPart"] = new(3, 3, [ParamKind.String, ParamKind.String, ParamKind.Int], "string"),
        ["concat"] = new(1, int.MaxValue, [ParamKind.Scalar], "string"),
        ["concatWs"] = new(2, int.MaxValue, [ParamKind.String, ParamKind.Scalar], "string"),
        ["substring"] = new(2, 3, [ParamKind.String, ParamKind.Int, ParamKind.Int], "string"),
        ["replace"] = new(3, 3, [ParamKind.String, ParamKind.String, ParamKind.String], "string"),
        ["left"] = new(2, 2, [ParamKind.String, ParamKind.Int], "string"),
        ["right"] = new(2, 2, [ParamKind.String, ParamKind.Int], "string"),
        ["length"] = new(1, 1, [ParamKind.String], "int"),
    };

    /// <summary>The field subtypes a cast may name in <c>as</c>.</summary>
    public static readonly IReadOnlyList<string> CastTargets =
    [
        FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
        FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIMESTAMP, FIELD_SUBTYPE_UUID,
    ];
    private static readonly HashSet<string> NumericSubtypes = new(StringComparer.Ordinal)
    {
        FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_CURRENCY,
    };
    private static readonly HashSet<string> IntegerSubtypes = new(StringComparer.Ordinal) { FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG };
    private static readonly HashSet<string> NonScalarSubtypes = new(StringComparer.Ordinal) { FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_MAP };

    /// <summary>Why a value of <paramref name="from"/> cannot be cast to <paramref name="to"/>, or null — TS <c>castProblem</c>.</summary>
    public static string? CastProblem(string? from, string to, bool intStoredEnum)
    {
        if (from is null) return null;
        if (NonScalarSubtypes.Contains(from)) return $"a field.{from} value cannot be cast";
        if (from == to) return null;
        if (from == FIELD_SUBTYPE_ENUM)
        {
            if (to == FIELD_SUBTYPE_STRING) return intStoredEnum ? "an int-stored enum (@intValueMap) cast to string gives its integer, not its member; cast it to int" : null;
            if (IntegerSubtypes.Contains(to)) return intStoredEnum ? null : "only an enum stored as an integer (@intValueMap) can be cast to a number";
            return $"an enum cannot be cast to {to}";
        }
        if (to == FIELD_SUBTYPE_STRING) return null;
        if (from == FIELD_SUBTYPE_STRING) return null;
        if (NumericSubtypes.Contains(to)) return NumericSubtypes.Contains(from) || from == FIELD_SUBTYPE_BOOLEAN ? null : $"a {from} cannot be cast to {to}";
        if (to == FIELD_SUBTYPE_BOOLEAN) return IntegerSubtypes.Contains(from) ? null : $"a {from} cannot be cast to boolean";
        if (to is FIELD_SUBTYPE_DATE or FIELD_SUBTYPE_TIMESTAMP)
            return from is FIELD_SUBTYPE_DATE or FIELD_SUBTYPE_TIMESTAMP ? null : $"a {from} cannot be cast to {to}";
        return $"a {from} cannot be cast to {to}";
    }

    /// <summary>
    /// The first node a CHECK condition cannot hold (case, now, cast, a function other than coalesce,
    /// a path), or null — TS <c>exprViewOnlyNode</c>.
    /// </summary>
    public static string? ExprViewOnlyNode(object? node)
    {
        if (node is not IReadOnlyDictionary<string, object?> n) return null;
        if (n.ContainsKey(EXPR_CAST)) return EXPR_CAST;
        if (n.ContainsKey(EXPR_CASE)) return EXPR_CASE;
        if (n.ContainsKey(EXPR_NOW)) return EXPR_NOW;
        if (n.ContainsKey(KEY_FN) && !Equals(Get(n, KEY_FN), EXPR_FN_COALESCE)) return Str(Get(n, KEY_FN));
        if (Get(n, KEY_FIELD) is string f && f.Contains('.')) return $"the path \"{f}\"";
        foreach (var key in new[] { KEY_LEFT, KEY_RIGHT, KEY_ARG })
            if (ExprViewOnlyNode(Get(n, key)) is { } hit) return hit;
        if (Get(n, KEY_ARGS) is IEnumerable<object?> args)
            foreach (var a in args)
                if (ExprViewOnlyNode(a) is { } hit) return hit;
        return null;
    }

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

    /// <summary>The field names an expression tree references, in order of appearance.</summary>
    public static List<string> FieldRefs(object? node)
    {
        var refs = new List<string>();
        void Walk(object? x)
        {
            if (x is not IReadOnlyDictionary<string, object?> n) return;
            if (Get(n, KEY_FIELD) is string f) refs.Add(f);
            Walk(Get(n, KEY_LEFT));
            Walk(Get(n, KEY_RIGHT));
            Walk(Get(n, KEY_ARG));
            if (Get(n, KEY_ARGS) is IEnumerable<object?> args) foreach (var a in args) Walk(a);
            Walk(Get(n, EXPR_CAST));
            Walk(Get(n, EXPR_CASE_OPERAND));
            Walk(Get(n, EXPR_CASE_ELSE));
            if (Get(n, EXPR_CASE) is IEnumerable<object?> arms)
                foreach (var arm in arms)
                    if (arm is IReadOnlyDictionary<string, object?> a) { Walk(Get(a, EXPR_CASE_WHEN)); Walk(Get(a, EXPR_CASE_THEN)); }
        }
        Walk(node);
        return refs;
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
            if (Get(n, EXPR_NOW) is not string) return [$"expression '{EXPR_NOW}' must be an ISO-8601 duration string"];
            var extra = n.Keys.Where(k => k != EXPR_NOW && k != EXPR_NOW_START_OF).ToList();
            return extra.Count == 0 ? [] : [$"expression '{EXPR_NOW}' takes only '{EXPR_NOW_START_OF}' beside it, not {string.Join(", ", extra)}"];
        }

        if (n.ContainsKey(EXPR_CASE))
        {
            if (Get(n, EXPR_CASE) is not IReadOnlyList<object?> arms || arms.Count == 0)
                return [$"'{EXPR_CASE}' requires a non-empty array of {{ {EXPR_CASE_WHEN}, {EXPR_CASE_THEN} }} arms"];
            var errs = new List<string>();
            foreach (var arm in arms)
            {
                if (arm is not IReadOnlyDictionary<string, object?> a || !a.ContainsKey(EXPR_CASE_WHEN) || !a.ContainsKey(EXPR_CASE_THEN))
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

        if (n.ContainsKey(EXPR_CAST))
        {
            var extra = n.Keys.Where(k => k != EXPR_CAST && k != EXPR_CAST_AS && k != EXPR_CAST_DB_COLUMN_TYPE).ToList();
            if (extra.Count > 0)
                return [$"expression '{EXPR_CAST}' takes only '{EXPR_CAST_AS}' and '{EXPR_CAST_DB_COLUMN_TYPE}' beside it, not {string.Join(", ", extra)}"];
            if (Get(n, EXPR_CAST_AS) is not string to || !CastTargets.Contains(to))
                return [$"'{EXPR_CAST}' requires '{EXPR_CAST_AS}': one of {string.Join(", ", CastTargets)}"];
            if (n.ContainsKey(EXPR_CAST_DB_COLUMN_TYPE))
            {
                var parsed = Get(n, EXPR_CAST_DB_COLUMN_TYPE) is string spelling ? MetaObjects.Persistence.Db.DbConstants.ParseDbColumnType(spelling) : null;
                if (parsed is null || parsed.Kind is "uuid" or "jsonb" || to != FIELD_SUBTYPE_STRING)
                    return [$"'{EXPR_CAST}' '{EXPR_CAST_DB_COLUMN_TYPE}' is a text spelling of @dbColumnType (text, varchar, character varying, varchar(n), character varying(n), character(n)) with '{EXPR_CAST_AS}: {FIELD_SUBTYPE_STRING}'"];
            }
            return ValidateExprNode(Get(n, EXPR_CAST));
        }

        if (n.ContainsKey(KEY_FN))
        {
            if (Get(n, KEY_FN) is not string fn || !Functions.TryGetValue(fn, out var sig))
                return [$"unknown expression fn '{Str(Get(n, KEY_FN))}'"];
            if (Get(n, KEY_ARGS) is not IReadOnlyList<object?> args || args.Count < Math.Max(sig.Min, 1))
                return [sig.Min <= 1 ? $"'{fn}' requires a non-empty args array" : $"'{fn}' requires at least {sig.Min} args"];
            if (args.Count > sig.Max) return [$"'{fn}' takes at most {sig.Max} args, got {args.Count}"];
            return args.SelectMany(ValidateExprNode).ToList();
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

        return ["expression node must be one of {field}, {value}, {op,…}, {fn,…}, {case,…}, {now}, {cast,…}"];
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
    public static InferResult InferExprType(object? node, Func<string, string?> resolveField, Func<string, bool>? isIntStoredEnum = null)
    {
        isIntStoredEnum ??= _ => false;
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

        // rc.19 now: an instant; compared with a date or local timestamp it takes that kind at lowering.
        if (n.ContainsKey(EXPR_NOW))
            return new InferResult(FIELD_SUBTYPE_TIMESTAMP, []);

        if (n.ContainsKey(EXPR_CASE))
        {
            var errors = new List<string>();
            var arms = (IReadOnlyList<object?>)Get(n, EXPR_CASE)!;
            InferResult? operand = n.ContainsKey(EXPR_CASE_OPERAND) ? InferExprType(Get(n, EXPR_CASE_OPERAND), resolveField, isIntStoredEnum) : null;
            if (operand is { } o) errors.AddRange(o.Errors);
            var results = new List<string?>();
            foreach (var armObj in arms)
            {
                var arm = (IReadOnlyDictionary<string, object?>)armObj!;
                var w = InferExprType(Get(arm, EXPR_CASE_WHEN), resolveField, isIntStoredEnum);
                errors.AddRange(w.Errors);
                if (operand is null && w.Type is not null && w.Type != FIELD_SUBTYPE_BOOLEAN)
                    errors.Add($"a searched '{EXPR_CASE}' needs a boolean '{EXPR_CASE_WHEN}', got {w.Type}");
                if (operand is { Type: { } ot } && w.Type is not null && w.Type != ot)
                    errors.Add($"a simple '{EXPR_CASE}' compares its {ot} '{EXPR_CASE_OPERAND}' with a {w.Type} '{EXPR_CASE_WHEN}'");
                var t = InferExprType(Get(arm, EXPR_CASE_THEN), resolveField, isIntStoredEnum);
                errors.AddRange(t.Errors);
                results.Add(t.Type);
            }
            if (n.ContainsKey(EXPR_CASE_ELSE))
            {
                var e = InferExprType(Get(n, EXPR_CASE_ELSE), resolveField, isIntStoredEnum);
                errors.AddRange(e.Errors);
                results.Add(e.Type);
            }
            var types = results.Where(t => t is not null).Select(t => t!).ToList();
            string? unified = types.Count > 0 ? types[0] : null;
            if (unified is not null && types.Any(t => t != unified))
                errors.Add($"'{EXPR_CASE}' results have differing types ({string.Join(", ", types.Distinct())})");
            return new InferResult(unified, errors);
        }

        if (n.ContainsKey(EXPR_CAST))
        {
            var inner = Get(n, EXPR_CAST);
            var operand = InferExprType(inner, resolveField, isIntStoredEnum);
            var to = (string)Get(n, EXPR_CAST_AS)!;
            var fieldRef = inner is IReadOnlyDictionary<string, object?> innerNode ? Get(innerNode, KEY_FIELD) as string : null;
            var problem = CastProblem(operand.Type, to, fieldRef is not null && isIntStoredEnum(fieldRef));
            return new InferResult(to, problem is null ? operand.Errors : [.. operand.Errors, $"'{EXPR_CAST}': {problem}"]);
        }

        if (n.ContainsKey(KEY_FN))
        {
            var name = (string)Get(n, KEY_FN)!;
            var sig = Functions[name];
            var args = (IReadOnlyList<object?>)Get(n, KEY_ARGS)!;
            var argResults = args.Select(a => InferExprType(a, resolveField, isIntStoredEnum)).ToList();
            var errors = argResults.SelectMany(a => a.Errors).ToList();
            var same = new List<string>();
            for (var i = 0; i < argResults.Count; i++)
            {
                var t = argResults[i].Type;
                if (t is null) continue; // a null literal fits any parameter
                var kind = sig.Params[Math.Min(i, sig.Params.Length - 1)];
                if (kind == ParamKind.Same) same.Add(t);
                else if (kind == ParamKind.String && t != FIELD_SUBTYPE_STRING) errors.Add($"'{name}' argument {i + 1} must be a string, got {t}");
                else if (kind == ParamKind.Int && !IntegerSubtypes.Contains(t)) errors.Add($"'{name}' argument {i + 1} must be an integer, got {t}");
                else if (kind == ParamKind.Scalar && NonScalarSubtypes.Contains(t)) errors.Add($"'{name}' argument {i + 1} must be a scalar, got {t}");
            }
            string? unified = same.Count > 0 ? same[0] : null;
            if (unified is not null && same.Any(t => t != unified))
                errors.Add($"'{name}' arguments have differing types ({string.Join(", ", same.Distinct())})");
            if (sig.Ordered && unified is not null && (unified == FIELD_SUBTYPE_BOOLEAN || NonScalarSubtypes.Contains(unified)))
                errors.Add($"'{name}' needs ordered arguments, got {unified}");
            var type = sig.Result == "same" ? unified : sig.Result == "int" ? FIELD_SUBTYPE_INT : FIELD_SUBTYPE_STRING;
            return new InferResult(type, errors);
        }

        var op = (string)Get(n, KEY_OP)!;
        if (ComparisonOps.Contains(op))
        {
            var l = InferExprType(Get(n, KEY_LEFT), resolveField, isIntStoredEnum);
            var r = InferExprType(Get(n, KEY_RIGHT), resolveField, isIntStoredEnum);
            var errors = l.Errors.Concat(r.Errors).ToList();
            if (l.Type is not null && !OpsForSubType(l.Type).Contains(op))
                errors.Add($"op '{op}' is not legal for a {l.Type} operand");
            return new InferResult(FIELD_SUBTYPE_BOOLEAN, errors);
        }
        if (NullOps.Contains(op))
            return new InferResult(FIELD_SUBTYPE_BOOLEAN, InferExprType(Get(n, KEY_ARG), resolveField, isIntStoredEnum).Errors.ToList());
        if (op == EXPR_OP_NOT || VariadicLogicOps.Contains(op))
        {
            var kids = op == EXPR_OP_NOT
                ? new List<object?> { Get(n, KEY_ARG) }
                : ((IReadOnlyList<object?>)Get(n, KEY_ARGS)!).ToList();
            var errors = new List<string>();
            foreach (var k in kids)
            {
                var kt = InferExprType(k, resolveField, isIntStoredEnum);
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
