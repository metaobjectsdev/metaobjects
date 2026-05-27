package com.metaobjects.attr;

import com.metaobjects.DataTypes;
import com.metaobjects.registry.MetaDataRegistry;

import java.io.IOException;
import java.io.StringReader;
import java.util.Properties;

/**
 * A Properties Attribute with provider-based registration.
 */
public class PropertiesAttribute extends MetaAttribute<Properties> {

    public final static String SUBTYPE_PROPERTIES = "properties";

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(PropertiesAttribute.class, def -> def
            .type(TYPE_ATTR).subType(SUBTYPE_PROPERTIES)
            .description("Properties attribute for key-value configuration data")
            .inheritsFrom(TYPE_ATTR, SUBTYPE_BASE)
        );
    }

    public PropertiesAttribute(String name ) {
        super( SUBTYPE_PROPERTIES, name, DataTypes.CUSTOM);
    }

    /**
     * Manually create a Properties MetaAttribute with a value
     */
    public static PropertiesAttribute create(String name, Properties value ) {
        PropertiesAttribute a = new PropertiesAttribute( name );
        a.setValue( value );
        return a;
    }

    @Override
    public void setValueAsObject(Object value) {
        if ( value == null ) {
            setValue( null );
        } else if ( value instanceof String ) {
            setValueAsString( (String) value );
        }
        else if ( value instanceof Properties ) {
            setValue((Properties) value);
        }
        else if ( value instanceof java.util.Map ) {
            // Inline-object form: canonical JSON parser passes a Map for `value: { ... }`.
            Properties p = new Properties();
            for (java.util.Map.Entry<?, ?> e : ((java.util.Map<?, ?>) value).entrySet()) {
                if (e.getKey() != null && e.getValue() != null) {
                    p.setProperty(e.getKey().toString(), e.getValue().toString());
                }
            }
            setValue(p);
        }
        else {
            throw new InvalidAttributeValueException( "Can not set value with class [" + value.getClass() + "] for object: " + value );
        }
    }

    @Override
    public void setValueAsString(String value) {
        if (value == null) { setValue(null); return; }
        String trimmed = value.trim();
        // Inline JSON-object form: `{"owner":"growth","tier":"gold"}` — the
        // canonical parser stringifies `value: { ... }` for us. Try JSON first;
        // fall back to the legacy java.util.Properties format on parse failure.
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
                com.google.gson.JsonObject obj =
                    com.google.gson.JsonParser.parseString(trimmed).getAsJsonObject();
                Properties p = new Properties();
                for (java.util.Map.Entry<String, com.google.gson.JsonElement> e : obj.entrySet()) {
                    com.google.gson.JsonElement el = e.getValue();
                    if (el.isJsonPrimitive()) {
                        p.setProperty(e.getKey(), el.getAsString());
                    } else {
                        p.setProperty(e.getKey(), el.toString());
                    }
                }
                setValue(p);
                return;
            } catch (com.google.gson.JsonSyntaxException | IllegalStateException ignore) {
                // Not valid JSON — fall through to Properties.load.
            }
        }
        try {
            Properties p = new Properties();
            p.load(new StringReader(value));
            setValue( p );
        } catch (IOException e) {
            throw new InvalidAttributeValueException("Could not load properties [" + value + "]: " + e.getMessage(), e);
        }
    }

    @Override
    public String getValueAsString() {
        return getValue().toString();
    }
}
