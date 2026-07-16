package com.metaobjects.attr;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonSyntaxException;
import com.metaobjects.DataTypes;
import com.metaobjects.registry.MetaDataRegistry;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
}
