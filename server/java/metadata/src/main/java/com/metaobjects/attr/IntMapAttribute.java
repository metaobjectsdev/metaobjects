package com.metaobjects.attr;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.metaobjects.DataTypes;
import com.metaobjects.registry.MetaDataRegistry;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * An object-shaped attribute whose values are all integers (e.g. field.enum's
 * {@code @intValueMap}: {@code {member: int}}).
 *
 * <p>Mirrors {@link PropertiesAttribute}'s role as an object-shaped key/value
 * attribute, but is backed by {@code Map<String, Integer>} rather than
 * {@code java.util.Properties} — {@code Properties} coerces every value to a
 * {@code String} on load, which would silently corrupt int fidelity on
 * canonical-JSON round-trip (TS/C#/Python all preserve real integers here).</p>
 *
 * <p>Declares {@link DataTypes#OBJECT} — the same data type {@link FilterAttribute}
 * uses for its object-shaped value — rather than {@link DataTypes#CUSTOM}. This
 * matters beyond typing: {@code CanonicalJsonSerializer#attrValueToJson} special-cases
 * {@code DataTypes.OBJECT} values that are a {@code Map} and serializes them via
 * {@code Gson.toJsonTree} (preserving integer values as JSON numbers); a
 * {@code DataTypes.CUSTOM} attribute falls through to {@code Object#toString()},
 * which would emit Java's {@code Map.toString()} form ({@code "{DRAFT=0}"}) — not
 * valid JSON. {@code PropertiesAttribute} gets away with {@code CUSTOM} only because
 * the serializer has a SEPARATE special case keyed on {@code instanceof Properties};
 * there is no such case for a plain {@code Map}, so this class must use
 * {@code DataTypes.OBJECT} to round-trip correctly.</p>
 *
 * <p>Generic shape check only here (object, every value an integer); a consumer
 * field type (field.enum) layers its own semantic content rules (key-set membership
 * against {@code @values}, no-duplicate-values) in its own post-load validation
 * pass ({@code ValidationPhase}).</p>
 */
public class IntMapAttribute extends MetaAttribute<Map<String, Integer>> {

    public static final String SUBTYPE_INT_MAP = "intMap";

    private static final Gson GSON = new Gson();

    /**
     * Register this type with the MetaDataRegistry (called by
     * {@link AttributeTypesMetaDataProvider}).
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(IntMapAttribute.class, def -> def
            .type(TYPE_ATTR).subType(SUBTYPE_INT_MAP)
            .description("An object-shaped attribute whose values are all integers "
                + "(e.g. field.enum's @intValueMap: {memberSymbol: int}). Generic shape "
                + "check only; a consumer field type layers its own semantic rules "
                + "(key-set membership, uniqueness) in its own content-rule validation.")
            .inheritsFrom(TYPE_ATTR, SUBTYPE_BASE)
        );
    }

    public IntMapAttribute(String name) {
        super(SUBTYPE_INT_MAP, name, DataTypes.OBJECT);
    }

    /**
     * Manually create an IntMap MetaAttribute with a value
     */
    public static IntMapAttribute create(String name, Map<String, Integer> value) {
        IntMapAttribute a = new IntMapAttribute(name);
        a.setValue(value);
        return a;
    }

    @Override
    public void setValueAsObject(Object value) {
        if (value == null) {
            setValue(null);
        } else if (value instanceof String) {
            setValueAsString((String) value);
        } else if (value instanceof Map) {
            Map<String, Integer> m = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                String key = e.getKey().toString();
                m.put(key, coerceInt(key, e.getValue()));
            }
            setValue(m);
        } else {
            throw new InvalidAttributeValueException(
                "Can not set value with class [" + value.getClass() + "] for object: " + value);
        }
    }

    @Override
    public void setValueAsString(String value) {
        if (value == null) { setValue(null); return; }
        String trimmed = value.trim();
        if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
            throw new InvalidAttributeValueException(
                "Could not parse intMap attribute '@" + getName()
                    + "' value (expected a JSON object): " + value);
        }
        JsonElement parsed;
        try {
            parsed = JsonParser.parseString(trimmed);
        } catch (JsonSyntaxException e) {
            throw new InvalidAttributeValueException(
                "Could not parse intMap attribute '@" + getName() + "' value as JSON: " + value, e);
        }
        if (!parsed.isJsonObject()) {
            throw new InvalidAttributeValueException(
                "intMap attribute '@" + getName() + "' value must be a JSON object: " + value);
        }
        JsonObject obj = parsed.getAsJsonObject();
        Map<String, Integer> m = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : obj.entrySet()) {
            JsonElement el = e.getValue();
            if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isNumber()) {
                double d = el.getAsDouble();
                if (d != Math.floor(d) || Double.isInfinite(d)
                        || d < Integer.MIN_VALUE || d > Integer.MAX_VALUE) {
                    throw new InvalidAttributeValueException(
                        "attribute '@" + getName() + "' member '" + e.getKey()
                            + "' has value '" + el + "' which is not an integer");
                }
                m.put(e.getKey(), (int) d);
            } else {
                throw new InvalidAttributeValueException(
                    "attribute '@" + getName() + "' member '" + e.getKey()
                        + "' has value '" + el + "' which is not an integer");
            }
        }
        setValue(m);
    }

    private static int coerceInt(String key, Object value) {
        if (value instanceof Integer i) return i;
        if (value instanceof Number n && n.doubleValue() == Math.floor(n.doubleValue())) {
            return n.intValue();
        }
        throw new InvalidAttributeValueException(
            "intMap value for member '" + key + "' is not an integer: " + value);
    }

    @Override
    public String getValueAsString() {
        Map<String, Integer> val = getValue();
        if (val == null) return "{}";
        return GSON.toJson(val);
    }
}
