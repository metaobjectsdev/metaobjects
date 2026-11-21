package com.metaobjects.attr;

import com.google.gson.Gson;
import org.junit.Test;

import java.util.List;
import java.util.Map;
import java.util.function.Function;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * The rc.21 view vocabulary of the expression grammar: the typed function set, {@code cast},
 * the cast legality table and the {@code dbColumnType} spelling rules. Mirrors the TypeScript
 * reference ({@code meta-attr-expression.ts}); the shared fixtures pin the same behaviour.
 */
public class ExpressionViewVocabularyTest {

    private static final Gson GSON = new Gson();

    private static final Map<String, String> FIELDS = Map.ofEntries(
        Map.entry("s", "string"), Map.entry("i", "int"), Map.entry("l", "long"), Map.entry("d", "decimal"),
        Map.entry("b", "boolean"), Map.entry("e", "enum"), Map.entry("ie", "enum"), Map.entry("o", "object"),
        Map.entry("ts", "timestamp"), Map.entry("dt", "date"), Map.entry("u", "uuid"));

    @SuppressWarnings("unchecked")
    private static Map<String, Object> expr(String json) {
        return (Map<String, Object>) GSON.fromJson(json, Map.class);
    }

    private static final Function<String, String> RESOLVE = FIELDS::get;

    private static List<String> infer(String json) {
        return ExpressionAttribute.inferExprType(expr(json), RESOLVE, name -> name.equals("ie")).errors;
    }

    private static String type(String json) {
        return ExpressionAttribute.inferExprType(expr(json), RESOLVE, name -> name.equals("ie")).type;
    }

    private static String fn(String name, String... args) {
        return "{\"fn\":\"" + name + "\",\"args\":[" + String.join(",", args) + "]}";
    }

    private static final String S = "{\"field\":\"s\"}";
    private static final String I = "{\"field\":\"i\"}";
    private static final String L = "{\"field\":\"l\"}";

    // --- structural arity ------------------------------------------------

    @Test
    public void everyFunctionIsRegisteredAndUnknownOnesAreRefused() {
        assertEquals(15, ExpressionAttribute.EXPR_FUNCTIONS.size());
        assertEquals(List.of("unknown expression fn 'drop'"),
            ExpressionAttribute.validateExprNode(expr(fn("drop", S))));
    }

    @Test
    public void arityErrorsNameTheFunction() {
        assertEquals(List.of("'lower' takes at most 1 args, got 2"),
            ExpressionAttribute.validateExprNode(expr(fn("lower", S, S))));
        assertEquals(List.of("'splitPart' requires at least 3 args"),
            ExpressionAttribute.validateExprNode(expr(fn("splitPart", S, S))));
        assertEquals(List.of("'nullif' requires at least 2 args"),
            ExpressionAttribute.validateExprNode(expr(fn("nullif", S))));
        assertEquals(List.of("'coalesce' requires a non-empty args array"),
            ExpressionAttribute.validateExprNode(expr("{\"fn\":\"coalesce\",\"args\":[]}")));
        assertEquals(List.of("'btrim' takes at most 2 args, got 3"),
            ExpressionAttribute.validateExprNode(expr(fn("btrim", S, S, S))));
        assertTrue(ExpressionAttribute.validateExprNode(expr(fn("concat", S, I, L, S))).isEmpty());
    }

    // --- parameter kinds and results -------------------------------------

    @Test
    public void stringParametersRefuseOtherTypes() {
        assertEquals(List.of("'lower' argument 1 must be a string, got int"), infer(fn("lower", I)));
        assertEquals("string", type(fn("upper", S)));
        assertEquals(List.of("'replace' argument 3 must be a string, got int"), infer(fn("replace", S, S, I)));
    }

    @Test
    public void intParametersRefuseLongWithACastHint() {
        assertEquals("string", type(fn("splitPart", S, S, I)));
        assertEquals(
            List.of("'left' argument 2 must be an int, got long; cast it ({ cast: <expr>, as: int })"),
            infer(fn("left", S, L)));
        assertEquals(List.of("'substring' argument 3 must be an int, got string"),
            infer(fn("substring", S, I, S)));
        assertEquals("int", type(fn("length", S)));
    }

    @Test
    public void scalarParametersRefuseObjects() {
        assertEquals("string", type(fn("concat", S, I, "{\"field\":\"b\"}")));
        assertEquals(List.of("'concat' argument 2 must be a scalar, got object"),
            infer(fn("concat", S, "{\"field\":\"o\"}")));
        assertEquals(List.of("'concatWs' argument 1 must be a string, got int"),
            infer(fn("concatWs", I, S)));
    }

    @Test
    public void sameParametersUnifyAndOrderedOnesRefuseBooleans() {
        assertEquals("int", type(fn("greatest", I, "{\"value\":3}")));
        assertEquals(List.of("'nullif' arguments have differing types (string, int)"), infer(fn("nullif", S, I)));
        assertEquals(List.of("'greatest' needs ordered arguments, got boolean"),
            infer(fn("greatest", "{\"field\":\"b\"}", "{\"field\":\"b\"}")));
        assertEquals("boolean", type(fn("coalesce", "{\"field\":\"b\"}", "{\"value\":true}")));
        // A null literal fits any parameter.
        assertEquals("string", type(fn("nullif", S, "{\"value\":null}")));
    }

    // --- cast ------------------------------------------------------------

    @Test
    public void castLegalityTableMatchesTheReference() {
        assertNull(ExpressionAttribute.castProblem(null, "int", false));
        assertNull(ExpressionAttribute.castProblem("int", "int", false));
        assertEquals("a field.object value cannot be cast", ExpressionAttribute.castProblem("object", "string", false));
        assertEquals("a field.map value cannot be cast", ExpressionAttribute.castProblem("map", "string", false));
        // anything to string, string to anything
        assertNull(ExpressionAttribute.castProblem("boolean", "string", false));
        assertNull(ExpressionAttribute.castProblem("uuid", "string", false));
        assertNull(ExpressionAttribute.castProblem("string", "uuid", false));
        // numbers among themselves; a boolean only to int
        assertNull(ExpressionAttribute.castProblem("currency", "decimal", false));
        assertNull(ExpressionAttribute.castProblem("boolean", "int", false));
        assertEquals("a boolean casts only to int, not long", ExpressionAttribute.castProblem("boolean", "long", false));
        assertEquals("a date cannot be cast to int", ExpressionAttribute.castProblem("date", "int", false));
        assertNull(ExpressionAttribute.castProblem("int", "boolean", false));
        assertEquals("a long cannot be cast to boolean; only an int can", ExpressionAttribute.castProblem("long", "boolean", false));
        // temporal
        assertNull(ExpressionAttribute.castProblem("date", "timestamp", false));
        assertNull(ExpressionAttribute.castProblem("timestamp", "date", false));
        assertEquals("a int cannot be cast to date", ExpressionAttribute.castProblem("int", "date", false));
        assertEquals("a uuid cannot be cast to int", ExpressionAttribute.castProblem("uuid", "int", false));
    }

    @Test
    public void intStoredEnumCastsToIntegersNotToString() {
        assertNull(ExpressionAttribute.castProblem("enum", "string", false));
        assertEquals("an int-stored enum (@intValueMap) cast to string gives its integer, not its member; cast it to int",
            ExpressionAttribute.castProblem("enum", "string", true));
        assertNull(ExpressionAttribute.castProblem("enum", "int", true));
        assertNull(ExpressionAttribute.castProblem("enum", "long", true));
        assertEquals("only an enum stored as an integer (@intValueMap) can be cast to a number",
            ExpressionAttribute.castProblem("enum", "int", false));
        assertEquals("an enum cannot be cast to decimal", ExpressionAttribute.castProblem("enum", "decimal", true));

        assertEquals("int", type("{\"cast\":{\"field\":\"ie\"},\"as\":\"int\"}"));
        assertTrue(infer("{\"cast\":{\"field\":\"ie\"},\"as\":\"int\"}").isEmpty());
        assertEquals(List.of("'cast': only an enum stored as an integer (@intValueMap) can be cast to a number"),
            infer("{\"cast\":{\"field\":\"e\"},\"as\":\"int\"}"));
    }

    @Test
    public void castOfANullLiteralTakesTheTargetType() {
        assertEquals("string", type("{\"cast\":{\"value\":null},\"as\":\"string\",\"dbColumnType\":\"varchar\"}"));
    }

    @Test
    public void castShapeRules() {
        assertTrue(ExpressionAttribute.validateExprNode(expr("{\"cast\":{\"field\":\"s\"},\"as\":\"uuid\"}")).isEmpty());
        assertEquals(1, ExpressionAttribute.validateExprNode(expr("{\"cast\":{\"field\":\"s\"},\"as\":\"object\"}")).size());
        assertEquals(1, ExpressionAttribute.validateExprNode(expr("{\"cast\":{\"field\":\"s\"}}")).size());
        assertEquals(List.of("expression 'cast' takes only 'as' and 'dbColumnType' beside it, not extra"),
            ExpressionAttribute.validateExprNode(expr("{\"cast\":{\"field\":\"s\"},\"as\":\"int\",\"extra\":1}")));
    }

    @Test
    public void castDbColumnTypeSpellings() {
        for (String ok : List.of("text", "varchar", "character varying", "varchar(10)", "character varying(255)", "character(3)")) {
            assertTrue(ok, ExpressionAttribute.validateExprNode(
                expr("{\"cast\":{\"field\":\"i\"},\"as\":\"string\",\"dbColumnType\":\"" + ok + "\"}")).isEmpty());
        }
        for (String bad : List.of("uuid", "jsonb", "VARCHAR", "varchar(0)", "char(3)", "varchar(10")) {
            assertEquals(bad, 1, ExpressionAttribute.validateExprNode(
                expr("{\"cast\":{\"field\":\"i\"},\"as\":\"string\",\"dbColumnType\":\"" + bad + "\"}")).size());
        }
        // A spelling is a text type: only with as: string.
        assertEquals(1, ExpressionAttribute.validateExprNode(
            expr("{\"cast\":{\"field\":\"s\"},\"as\":\"int\",\"dbColumnType\":\"varchar\"}")).size());
        // And a non-string spelling is refused.
        assertEquals(1, ExpressionAttribute.validateExprNode(
            expr("{\"cast\":{\"field\":\"s\"},\"as\":\"string\",\"dbColumnType\":5}")).size());
    }

    // --- view-only nodes (the CHECK-condition subset) ----------------------

    @Test
    public void exprViewOnlyNodeFindsWhatACheckCannotHold() {
        assertNull(ExpressionAttribute.exprViewOnlyNode(expr(fn("coalesce", S, "{\"value\":\"x\"}"))));
        assertEquals("cast", ExpressionAttribute.exprViewOnlyNode(expr("{\"cast\":{\"field\":\"s\"},\"as\":\"int\"}")));
        assertEquals("lower", ExpressionAttribute.exprViewOnlyNode(
            expr("{\"op\":\"eq\",\"left\":" + fn("lower", S) + ",\"right\":{\"value\":\"a\"}}")));
        assertEquals("the path \"a.b\"", ExpressionAttribute.exprViewOnlyNode(expr("{\"field\":\"a.b\"}")));
    }
}
