package com.metaobjects.attr;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
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
 * A Filter Attribute that holds an object-valued {@code attr.filter} value in
 * normalized (desugared) canonical form.
 *
 * <p>The {@code @filter} attribute on a field declares filter constraints as a
 * typed JSON object. Authoring shortcuts are desugared at parse time:</p>
 * <ul>
 *   <li>Scalar value {@code v} → {@code {eq: v}}</li>
 *   <li>Array value {@code [...]} → {@code {in: [...]}}</li>
 *   <li>JSON {@code null} → {@code {isNull: true}}</li>
 *   <li>Explicit {@code {op: value}} clause → passed through unchanged</li>
 *   <li>{@code or} / {@code and} composition keys recurse into their sub-filter arrays</li>
 * </ul>
 *
 * <p>ALL desugar logic is encapsulated here — no central parser, converter, or
 * validator edits are required. The canonical JSON parser is 100% registry-driven:
 * it creates this class via the registry and calls {@link #setValueAsString(String)}
 * with the raw JSON object text, which triggers desugar automatically.</p>
 *
 * <p>Value type: {@code Map<String,Object>} (a recursive structure whose leaf values
 * are the op-value pairs produced by desugar).</p>
 *
 * @since 6.0.0
 */
public class FilterAttribute extends MetaAttribute<Map<String, Object>> {

    public static final String SUBTYPE_FILTER = "filter";

    // Composition keys — recurse into sub-filter arrays
    private static final String COMPOSE_OR  = "or";
    private static final String COMPOSE_AND = "and";

    // Filter operator names (canonical vocabulary — identical across all language ports)
    private static final String OP_EQ      = "eq";
    private static final String OP_IN      = "in";
    private static final String OP_IS_NULL = "isNull";

    /** Singleton Gson for round-trip JSON — shared, thread-safe. */
    private static final Gson GSON = new Gson();

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /**
     * Registers {@code attr.filter} with the MetaDataRegistry.
     * Called by {@link AttributeTypesMetaDataProvider}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(FilterAttribute.class, def -> def
            .type(TYPE_ATTR).subType(SUBTYPE_FILTER)
            .description("Filter attribute holding a desugared filter constraint object")
            .inheritsFrom(TYPE_ATTR, SUBTYPE_BASE)
        );
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    public FilterAttribute(String name) {
        super(SUBTYPE_FILTER, name, DataTypes.OBJECT);
    }

    // -----------------------------------------------------------------------
    // Value setters — parse + desugar
    // -----------------------------------------------------------------------

    /**
     * Sets the value from a JSON string (typically a JSON object, e.g.
     * {@code {"subscribed":true}}).  Parses the JSON, desugars shorthand
     * clauses, and stores the result.
     *
     * <p>Called by the canonical JSON parser with the raw JSON text of the
     * attribute's value element (e.g. the serialized form of a JSON object or
     * scalar). If the value is a JSON object, it is desugared; otherwise a
     * scalar or array is wrapped in a single-field desugared map.</p>
     */
    @Override
    public void setValueAsString(String json) {
        if (json == null) {
            setValue(null);
            return;
        }
        try {
            JsonElement el = JsonParser.parseString(json);
            setValue(desugarElement(el));
        } catch (JsonSyntaxException e) {
            throw new InvalidAttributeValueException(
                "Could not parse filter value as JSON [" + json + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Sets the value from an arbitrary object.
     *
     * <ul>
     *   <li>{@code null} → stores {@code null}</li>
     *   <li>{@code String} → delegates to {@link #setValueAsString(String)}</li>
     *   <li>{@code Map} → desugars and stores</li>
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
            setValue(desugarMap((Map<String, Object>) value));
        } else {
            throw new InvalidAttributeValueException(
                "Cannot set filter value with class [" + value.getClass() + "]: " + value);
        }
    }

    // -----------------------------------------------------------------------
    // Value getter — serialize to canonical JSON text
    // -----------------------------------------------------------------------

    /**
     * Returns the desugared filter map serialized as a canonical JSON object string.
     * Returns an empty JSON object {@code {}} when the value is {@code null}.
     *
     * <p>Note: an absent/null filter serializes to {@code {}} by design, unlike
     * {@link PropertiesAttribute#getValueAsString()} which returns {@code null}.
     * This preserves a valid JSON object shape for downstream consumers.</p>
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
    // Desugar — private, encapsulated here
    // -----------------------------------------------------------------------

    /**
     * Desugars an arbitrary JSON element that is the top-level value of an
     * {@code @filter} attribute.  When the element is a JSON object it is
     * desugared field-by-field; any other shape is treated as a bare scalar /
     * array to wrap (unusual but handled gracefully).
     */
    private static Map<String, Object> desugarElement(JsonElement el) {
        if (el == null || el.isJsonNull()) {
            return null;
        }
        if (el.isJsonObject()) {
            return desugarJsonObject(el.getAsJsonObject());
        }
        // Bare scalar / array at top level: desugar as a single "eq"/"in" clause.
        // This is an edge case — normal filter attrs are objects — but we handle it
        // gracefully rather than throwing.
        Map<String, Object> out = new LinkedHashMap<>();
        out.put(OP_EQ, jsonElementToJava(el));
        return out;
    }

    /**
     * Desugars a filter JSON object: iterates each key and desugars its value.
     * {@code or}/{@code and} composition keys are recursed into their sub-filter arrays;
     * all other keys are treated as field names whose values are filter clauses.
     */
    private static Map<String, Object> desugarJsonObject(JsonObject obj) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> entry : obj.entrySet()) {
            String key = entry.getKey();
            JsonElement raw = entry.getValue();

            if (COMPOSE_OR.equals(key) || COMPOSE_AND.equals(key)) {
                // Composition: value must be an array of sub-filter objects; recurse.
                if (raw.isJsonArray()) {
                    List<Object> subFilters = new ArrayList<>();
                    for (JsonElement sub : raw.getAsJsonArray()) {
                        if (sub.isJsonObject()) {
                            subFilters.add(desugarJsonObject(sub.getAsJsonObject()));
                        } else {
                            subFilters.add(jsonElementToJava(sub));
                        }
                    }
                    out.put(key, subFilters);
                } else {
                    out.put(key, jsonElementToJava(raw));
                }
            } else {
                // Field name: desugar the clause value
                out.put(key, desugarClause(raw));
            }
        }
        return out;
    }

    /**
     * Desugars a single filter clause value for one field in a filter object.
     * Mirrors {@code desugarClause} in {@code parser-core.ts} exactly:
     * <ul>
     *   <li>JSON null → {@code {isNull: true}}</li>
     *   <li>JSON array → {@code {in: [...]}}</li>
     *   <li>JSON object → passed through as-is (explicit op form, no re-recursion)</li>
     *   <li>Scalar → {@code {eq: scalar}}</li>
     * </ul>
     *
     * <p>Note: unlike {@link #desugarJsonObject}, this method does NOT recurse into
     * a JSON object value. An object value is already in canonical {@code {op: value}}
     * form and must be preserved verbatim.</p>
     */
    private static Map<String, Object> desugarClause(JsonElement raw) {
        Map<String, Object> clause = new LinkedHashMap<>();

        if (raw == null || raw.isJsonNull()) {
            clause.put(OP_IS_NULL, true);
            return clause;
        }
        if (raw.isJsonArray()) {
            List<Object> items = new ArrayList<>();
            for (JsonElement item : raw.getAsJsonArray()) {
                items.add(jsonElementToJava(item));
            }
            clause.put(OP_IN, items);
            return clause;
        }
        if (raw.isJsonObject()) {
            // Explicit op-value object — convert to Java map and pass through unchanged.
            // Do NOT recurse into desugarJsonObject — the keys here are op names, not field names.
            Map<String, Object> opMap = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> e : raw.getAsJsonObject().entrySet()) {
                opMap.put(e.getKey(), jsonElementToJava(e.getValue()));
            }
            return opMap;
        }
        // Scalar
        clause.put(OP_EQ, jsonElementToJava(raw));
        return clause;
    }

    /**
     * Desugars a Java {@code Map<String,Object>} (when the value arrives via
     * {@link #setValueAsObject(Object)}).  Converts the map to a Gson JsonObject
     * and delegates to {@link #desugarJsonObject(JsonObject)}.
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> desugarMap(Map<String, Object> map) {
        // Round-trip through Gson to get a consistent JsonObject representation
        JsonElement el = GSON.toJsonTree(map);
        if (el.isJsonObject()) {
            return desugarJsonObject(el.getAsJsonObject());
        }
        return map;
    }

    /**
     * Converts a {@link JsonElement} to an idiomatic Java value:
     * Boolean, Number (Long or Double), String, or {@code null}.
     */
    private static Object jsonElementToJava(JsonElement el) {
        if (el == null || el.isJsonNull()) {
            return null;
        }
        if (el.isJsonPrimitive()) {
            JsonPrimitive p = el.getAsJsonPrimitive();
            if (p.isBoolean()) return p.getAsBoolean();
            if (p.isNumber()) {
                // Prefer Long for integer values within long range; Double otherwise
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
