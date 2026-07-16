package com.metaobjects.attr;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonSyntaxException;
import com.metaobjects.DataTypes;
import com.metaobjects.field.BooleanField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.StringField;
import com.metaobjects.query.FilterOps;
import com.metaobjects.registry.MetaDataRegistry;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * An Expression Attribute that holds an object-valued {@code attr.expression} value
 * — a structured expression tree stored <strong>verbatim</strong> (#195).
 *
 * <p>The {@code @expr} attribute on an {@code origin.computed} declares a structured
 * expression tree (closed node grammar: field/value refs, comparisons sharing the
 * filter op vocabulary, {@code isNull}/{@code isNotNull}, {@code and}/{@code or}/
 * {@code not}, {@code coalesce}). Unlike {@link FilterAttribute}, the tree is stored
 * <em>as authored</em> — there is NO desugar transform. The value is parsed into a
 * {@code Map<String,Object>} preserving key order and re-serialized byte-identically.</p>
 *
 * <p>Value type: {@code Map<String,Object>} (a recursive structure whose leaf values
 * are the node's operands — strings, numbers, booleans, nested nodes, or arrays).</p>
 *
 * @since 7.8.0
 */
public class ExpressionAttribute extends MetaAttribute<Map<String, Object>> {

    public static final String SUBTYPE_EXPRESSION = "expression";

    /** Singleton Gson for round-trip JSON — shared, thread-safe. */
    private static final Gson GSON = new Gson();

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /**
     * Registers {@code attr.expression} with the MetaDataRegistry.
     * Called by {@link AttributeTypesMetaDataProvider}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(ExpressionAttribute.class, def -> def
            .type(TYPE_ATTR).subType(SUBTYPE_EXPRESSION)
            .description("Expression attribute holding a structured expression tree (stored verbatim)")
            .inheritsFrom(TYPE_ATTR, SUBTYPE_BASE)
        );
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    public ExpressionAttribute(String name) {
        super(SUBTYPE_EXPRESSION, name, DataTypes.OBJECT);
    }

    // -----------------------------------------------------------------------
    // Value setters — parse VERBATIM (no desugar)
    // -----------------------------------------------------------------------

    /**
     * Sets the value from a JSON string (the raw JSON object text of the expression
     * tree). Parses the JSON into a Java {@code Map}/{@code List}/scalar structure
     * preserving key order and stores it unchanged — no desugar (unlike
     * {@link FilterAttribute#setValueAsString(String)}).
     */
    @Override
    public void setValueAsString(String json) {
        if (json == null) {
            setValue(null);
            return;
        }
        try {
            JsonElement el = JsonParser.parseString(json);
            setValue(toJavaMap(el));
        } catch (JsonSyntaxException e) {
            throw new InvalidAttributeValueException(
                "Could not parse expression value as JSON [" + json + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Sets the value from an arbitrary object.
     *
     * <ul>
     *   <li>{@code null} → stores {@code null}</li>
     *   <li>{@code String} → delegates to {@link #setValueAsString(String)}</li>
     *   <li>{@code Map} → normalized (round-tripped through Gson) and stored verbatim</li>
     * </ul>
     */
    @Override
    @SuppressWarnings("unchecked")
    public void setValueAsObject(Object value) {
        if (value == null) {
            setValue(null);
        } else if (value instanceof String) {
            setValueAsString((String) value);
        } else if (value instanceof Map) {
            // Round-trip through Gson for a consistent leaf-value representation
            // (Long/Double normalization), preserving key order. No desugar.
            setValue(toJavaMap(GSON.toJsonTree(value)));
        } else {
            throw new InvalidAttributeValueException(
                "Cannot set expression value with class [" + value.getClass() + "]: " + value);
        }
    }

    // -----------------------------------------------------------------------
    // Value getter — serialize to canonical JSON text
    // -----------------------------------------------------------------------

    /**
     * Returns the expression tree serialized as a canonical JSON object string.
     * Returns an empty JSON object {@code {}} when the value is {@code null}
     * (mirrors {@link FilterAttribute#getValueAsString()}).
     */
    @Override
    public String getValueAsString() {
        Map<String, Object> val = getValue();
        if (val == null) {
            return "{}";
        }
        return GSON.toJson(val);
    }

    // -----------------------------------------------------------------------
    // Verbatim JSON → Java conversion (no desugar)
    // -----------------------------------------------------------------------

    /**
     * Converts the top-level JSON element of an {@code @expr} attribute to a
     * {@code Map<String,Object>}. Any non-object top-level value (unusual — an
     * expression tree is an object) is wrapped as a single-entry {@code {value: …}}
     * map so a valid object shape is preserved.
     */
    private static Map<String, Object> toJavaMap(JsonElement el) {
        if (el == null || el.isJsonNull()) {
            return null;
        }
        Object java = jsonElementToJava(el);
        if (java instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) java;
            return map;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("value", java);
        return out;
    }

    /**
     * Converts a {@link JsonElement} to an idiomatic Java value, preserving object
     * key order (LinkedHashMap): Boolean, Number (Long or Double), String, List, Map,
     * or {@code null}. Mirrors {@link FilterAttribute}'s converter — identical leaf
     * semantics, no desugar of clause shapes.
     */
    private static Object jsonElementToJava(JsonElement el) {
        if (el == null || el.isJsonNull()) {
            return null;
        }
        if (el.isJsonPrimitive()) {
            JsonPrimitive p = el.getAsJsonPrimitive();
            if (p.isBoolean()) return p.getAsBoolean();
            if (p.isNumber()) {
                double d = p.getAsDouble();
                if (d == Math.floor(d) && !Double.isInfinite(d)
                        && d >= (double) Long.MIN_VALUE && d <= (double) Long.MAX_VALUE) {
                    return p.getAsLong();
                }
                return d;
            }
            return p.getAsString();
        }
        if (el.isJsonArray()) {
            List<Object> list = new ArrayList<>();
            for (JsonElement item : el.getAsJsonArray()) {
                list.add(jsonElementToJava(item));
            }
            return list;
        }
        if (el.isJsonObject()) {
            Map<String, Object> map = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> e : el.getAsJsonObject().entrySet()) {
                map.put(e.getKey(), jsonElementToJava(e.getValue()));
            }
            return map;
        }
        return el.toString();
    }

    // =======================================================================
    // Closed expression node grammar (#195) — the port of the TS reference
    // `meta-attr-expression.ts` (validateExprNode + inferExprType). The other
    // ports store {@code @expr} verbatim and validate the CLOSED grammar in the
    // origin.computed validation pass (Java: ValidationPhase#validateOrigins),
    // NOT in this attr class (mirrors FilterAttribute, which validates only
    // shape). These static helpers are the single cross-port grammar the pass
    // calls, so every port validates identically.
    //
    // Node kinds (Map-shaped, matching the canonical JSON):
    //   { "field": name }                        — base-entity field ref
    //   { "value": literal }                     — scalar literal
    //   { "op": <cmp>, "left": …, "right": … }   — comparison (eq/ne/gt/gte/lt/lte)
    //   { "op": isNull|isNotNull|not, "arg": … } — null-test / negation
    //   { "op": and|or, "args": [ … ] }          — variadic logic
    //   { "fn": coalesce, "args": [ … ] }        — coalesce
    // =======================================================================

    /** Expression-only op/fn names — the comparison + and/or/isNull names are the
     *  shared filter vocabulary ({@link FilterOps}); these three are new. */
    public static final String EXPR_OP_IS_NOT_NULL = "isNotNull";
    public static final String EXPR_OP_NOT = "not";
    public static final String EXPR_FN_COALESCE = "coalesce";

    /** Boolean composition keys — mirror {@code FilterAttribute}'s private compose keys. */
    static final String COMPOSE_AND = "and";
    static final String COMPOSE_OR = "or";

    private static Set<String> orderedSet(String... names) {
        Set<String> s = new LinkedHashSet<>(names.length);
        java.util.Collections.addAll(s, names);
        return java.util.Collections.unmodifiableSet(s);
    }

    private static final Set<String> COMPARISON_OPS = orderedSet(
        FilterOps.FILTER_OP_EQ, FilterOps.FILTER_OP_NE, FilterOps.FILTER_OP_GT,
        FilterOps.FILTER_OP_GTE, FilterOps.FILTER_OP_LT, FilterOps.FILTER_OP_LTE);
    private static final Set<String> NULL_OPS = orderedSet(
        FilterOps.FILTER_OP_IS_NULL, EXPR_OP_IS_NOT_NULL);
    private static final Set<String> VARIADIC_LOGIC_OPS = orderedSet(COMPOSE_AND, COMPOSE_OR);

    /**
     * Structural well-formedness of an expression tree (known node kinds, ops,
     * arity). Returns an empty list when valid; each entry is a human-readable
     * reason. No entity/type context — see {@link #inferExprType} for typing.
     * Mirrors the TS {@code validateExprNode}.
     */
    public static List<String> validateExprNode(Object node) {
        List<String> out = new ArrayList<>();
        if (!(node instanceof Map)) {
            out.add("expression node must be an object, got " + runtimeShape(node));
            return out;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> n = (Map<String, Object>) node;
        if (n.containsKey("field")) {
            Object f = n.get("field");
            if (!(f instanceof String) || ((String) f).isEmpty()) {
                out.add("expression 'field' must be a non-empty string");
            }
            return out;
        }
        if (n.containsKey("value")) {
            Object v = n.get("value");
            if (!(v == null || v instanceof String || v instanceof Number || v instanceof Boolean)) {
                out.add("expression 'value' must be a scalar literal (string/number/boolean/null)");
            }
            return out;
        }
        if (n.containsKey("fn")) {
            Object fn = n.get("fn");
            if (!EXPR_FN_COALESCE.equals(fn)) {
                out.add("unknown expression fn '" + String.valueOf(fn) + "'");
                return out;
            }
            Object args = n.get("args");
            if (args instanceof List && !((List<?>) args).isEmpty()) {
                for (Object a : (List<?>) args) out.addAll(validateExprNode(a));
            } else {
                out.add("'" + EXPR_FN_COALESCE + "' requires a non-empty args array");
            }
            return out;
        }
        if (n.containsKey("op")) {
            Object opObj = n.get("op");
            if (!(opObj instanceof String)) {
                out.add("expression 'op' must be a string");
                return out;
            }
            String op = (String) opObj;
            if (COMPARISON_OPS.contains(op)) {
                if (n.containsKey("left") && n.containsKey("right")) {
                    out.addAll(validateExprNode(n.get("left")));
                    out.addAll(validateExprNode(n.get("right")));
                } else {
                    out.add("comparison op '" + op + "' requires 'left' and 'right'");
                }
                return out;
            }
            if (NULL_OPS.contains(op) || EXPR_OP_NOT.equals(op)) {
                if (n.containsKey("arg")) out.addAll(validateExprNode(n.get("arg")));
                else out.add("op '" + op + "' requires 'arg'");
                return out;
            }
            if (VARIADIC_LOGIC_OPS.contains(op)) {
                Object args = n.get("args");
                if (args instanceof List && !((List<?>) args).isEmpty()) {
                    for (Object a : (List<?>) args) out.addAll(validateExprNode(a));
                } else {
                    out.add("op '" + op + "' requires a non-empty args array");
                }
                return out;
            }
            out.add("unknown expression op '" + op + "'");
            return out;
        }
        out.add("expression node must be one of {field}, {value}, {op,…}, {fn,…}");
        return out;
    }

    /** The subtype of a scalar literal (coarse: an integral number → int, else double). */
    private static String literalType(Object v) {
        if (v instanceof String) return StringField.SUBTYPE_STRING;
        if (v instanceof Boolean) return BooleanField.SUBTYPE_BOOLEAN;
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            boolean integral = (d == Math.floor(d)) && !Double.isInfinite(d);
            return integral ? IntegerField.SUBTYPE_INT : DoubleField.SUBTYPE_DOUBLE;
        }
        return null; // null literal
    }

    /** The result of {@link #inferExprType}: the inferred root subType (or
     *  {@code null} when untypable) plus any type/resolution/op-legality errors. */
    public static final class InferResult {
        /** The inferred field subType of the expression's root, or {@code null}. */
        public final String type;
        /** Type/resolution/op-legality errors (empty when the tree types cleanly). */
        public final List<String> errors;
        InferResult(String type, List<String> errors) { this.type = type; this.errors = errors; }
    }

    /**
     * Bottom-up type inference for a computed expression. {@code resolveField}
     * returns the subType of a base-entity field ref ({@code null} = unresolvable).
     * Comparisons / null-tests / logic → boolean; a field ref → its subType;
     * coalesce → the unified arg subType. Also enforces per-operand op legality
     * against the filter bands ({@link FilterOps#opsForSubType}), so e.g. {@code gt}
     * on a boolean operand is rejected. Mirrors the TS {@code inferExprType}.
     */
    public static InferResult inferExprType(Object node, Function<String, String> resolveField) {
        List<String> structural = validateExprNode(node);
        if (!structural.isEmpty()) return new InferResult(null, structural);
        @SuppressWarnings("unchecked")
        Map<String, Object> n = (Map<String, Object>) node;

        if (n.containsKey("field")) {
            String t = resolveField.apply((String) n.get("field"));
            if (t == null) {
                return new InferResult(null, List.of(
                    "expression field '" + String.valueOf(n.get("field"))
                        + "' does not resolve to a base entity field"));
            }
            return new InferResult(t, List.of());
        }
        if (n.containsKey("value")) {
            return new InferResult(literalType(n.get("value")), List.of());
        }
        if (n.containsKey("fn")) { // coalesce
            List<String> errors = new ArrayList<>();
            List<String> argTypes = new ArrayList<>();
            for (Object a : (List<?>) n.get("args")) {
                InferResult r = inferExprType(a, resolveField);
                errors.addAll(r.errors);
                if (r.type != null) argTypes.add(r.type);
            }
            String unified = argTypes.isEmpty() ? null : argTypes.get(0);
            if (unified != null) {
                boolean differ = false;
                for (String t : argTypes) if (!unified.equals(t)) { differ = true; break; }
                if (differ) {
                    Set<String> distinct = new LinkedHashSet<>(argTypes);
                    errors.add("'" + EXPR_FN_COALESCE + "' arguments have differing types ("
                        + String.join(", ", distinct) + ")");
                }
            }
            return new InferResult(unified, errors);
        }

        String op = (String) n.get("op");
        if (COMPARISON_OPS.contains(op)) {
            InferResult l = inferExprType(n.get("left"), resolveField);
            InferResult r = inferExprType(n.get("right"), resolveField);
            List<String> errors = new ArrayList<>(l.errors);
            errors.addAll(r.errors);
            if (l.type != null && !FilterOps.opsForSubType(l.type).contains(op)) {
                errors.add("op '" + op + "' is not legal for a " + l.type + " operand");
            }
            return new InferResult(BooleanField.SUBTYPE_BOOLEAN, errors);
        }
        if (NULL_OPS.contains(op)) {
            return new InferResult(BooleanField.SUBTYPE_BOOLEAN,
                inferExprType(n.get("arg"), resolveField).errors);
        }
        if (EXPR_OP_NOT.equals(op) || VARIADIC_LOGIC_OPS.contains(op)) {
            List<Object> kids = new ArrayList<>();
            if (EXPR_OP_NOT.equals(op)) kids.add(n.get("arg"));
            else for (Object a : (List<?>) n.get("args")) kids.add(a);
            List<String> errors = new ArrayList<>();
            for (Object k : kids) {
                InferResult kt = inferExprType(k, resolveField);
                errors.addAll(kt.errors);
                if (kt.type != null && !BooleanField.SUBTYPE_BOOLEAN.equals(kt.type)) {
                    errors.add("op '" + op + "' requires boolean operands, got " + kt.type);
                }
            }
            return new InferResult(BooleanField.SUBTYPE_BOOLEAN, errors);
        }
        return new InferResult(null, List.of("unknown expression op '" + op + "'"));
    }

    /** Coarse runtime shape label for a malformed top-level node (parity with the
     *  TS {@code null}/{@code array}/{@code typeof} message forms). */
    private static String runtimeShape(Object v) {
        if (v == null) return "null";
        if (v instanceof List) return "array";
        if (v instanceof Boolean) return "boolean";
        if (v instanceof Number) return "number";
        if (v instanceof String) return "string";
        return v.getClass().getSimpleName();
    }
}
