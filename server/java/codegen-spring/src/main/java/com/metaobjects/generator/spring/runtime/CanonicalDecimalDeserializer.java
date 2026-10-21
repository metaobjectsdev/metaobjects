package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.BeanProperty;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.deser.ContextualDeserializer;
import com.fasterxml.jackson.databind.deser.std.StdDeserializer;

import java.io.IOException;
import java.math.BigDecimal;

/**
 * Strict Jackson deserializer for a decimal record component (W2): a JSON string in the
 * JSON-number grammar, or a JSON number read exactly. Everything else is an error that Spring
 * maps to {@code 400}: {@code ""} (which Jackson's default coercion would turn into
 * {@code null}), padded or {@code NaN}/{@code Infinity} strings, a boolean, an array, an object,
 * and a value outside the W3 range. JSON {@code null} never reaches this class: Jackson binds it
 * to {@code null}.
 */
public final class CanonicalDecimalDeserializer extends StdDeserializer<BigDecimal> implements ContextualDeserializer {

    private static final long serialVersionUID = 1L;

    /** The declared bound (W3), or {@code null} when the property declares none. */
    private final DeclaredDecimal bound;

    public CanonicalDecimalDeserializer() {
        this(null);
    }

    private CanonicalDecimalDeserializer(DeclaredDecimal bound) {
        super(BigDecimal.class);
        this.bound = bound;
    }

    /** Binds the deserializer to the {@link DeclaredDecimal} of the property it reads, if any. */
    @Override
    public JsonDeserializer<?> createContextual(DeserializationContext ctxt, BeanProperty property) {
        DeclaredDecimal declared = property == null ? null : property.getAnnotation(DeclaredDecimal.class);
        return declared == null ? this : new CanonicalDecimalDeserializer(declared);
    }

    @Override
    public BigDecimal deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
        JsonToken token = p.currentToken();
        try {
            if (token == JsonToken.VALUE_STRING) {
                return declared(CanonicalDecimal.parse(p.getText()));
            }
            if (token == JsonToken.VALUE_NUMBER_INT || token == JsonToken.VALUE_NUMBER_FLOAT) {
                return declared(CanonicalDecimal.fromJsonNumber(p.getDecimalValue()));
            }
        } catch (CanonicalDecimal.InvalidDecimalException e) {
            return (BigDecimal) ctxt.handleWeirdStringValue(BigDecimal.class, p.getText(), "%s", e.getMessage());
        }
        return (BigDecimal) ctxt.handleUnexpectedToken(BigDecimal.class, p);
    }

    private BigDecimal declared(BigDecimal value) {
        return bound == null ? value : CanonicalDecimal.checkDeclared(value, bound.precision(), bound.scale());
    }

    /**
     * The same rule over an already-parsed tree node, bounded by the declared column (W3): for the
     * generated {@code <Entity>Patch} of a field that declares {@code @precision}.
     *
     * @throws CanonicalDecimal.InvalidDecimalException as {@link #fromNode(JsonNode)}, and for a
     *         value the column cannot hold
     */
    public static BigDecimal fromNode(JsonNode node, int precision, int scale) {
        return CanonicalDecimal.checkDeclared(fromNode(node), precision, scale);
    }

    /**
     * The same rule over an already-parsed tree node, for the generated {@code <Entity>Patch}
     * (which reads a body as a {@code JsonNode}).
     *
     * @throws CanonicalDecimal.InvalidDecimalException for a node that is not a canonical-grammar
     *         string or a number, or is out of range
     */
    public static BigDecimal fromNode(JsonNode node) {
        if (node.isTextual()) return CanonicalDecimal.parse(node.asText());
        if (node.isNumber()) return CanonicalDecimal.fromJsonNumber(node.decimalValue());
        throw new CanonicalDecimal.InvalidDecimalException("not a decimal: " + node);
    }
}
