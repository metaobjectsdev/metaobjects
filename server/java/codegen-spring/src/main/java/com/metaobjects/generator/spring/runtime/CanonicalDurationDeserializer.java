package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.deser.std.StdDeserializer;

import java.io.IOException;
import java.time.Duration;

/**
 * Strict Jackson deserializer for a {@code field.duration} record component: a JSON string in
 * the accepted ISO-8601 form ({@link CanonicalDuration#ACCEPTED}). Everything else — a number of
 * seconds, a calendar span ({@code P1M}), a clock string ({@code 1:30:00}), a lowercase or
 * fractional-hour form {@link Duration#parse} would take — is an error Spring maps to {@code 400}.
 * JSON {@code null} never reaches this class: Jackson binds it to {@code null}.
 */
public final class CanonicalDurationDeserializer extends StdDeserializer<Duration> {

    private static final long serialVersionUID = 1L;

    public CanonicalDurationDeserializer() {
        super(Duration.class);
    }

    @Override
    public Duration deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
        if (p.currentToken() != JsonToken.VALUE_STRING) {
            return (Duration) ctxt.handleUnexpectedToken(Duration.class, p);
        }
        try {
            return CanonicalDuration.parse(p.getText());
        } catch (CanonicalDuration.InvalidDurationException e) {
            return (Duration) ctxt.handleWeirdStringValue(Duration.class, p.getText(), "%s", e.getMessage());
        }
    }

    /**
     * The same rule over an already-parsed tree node, for the generated {@code <Entity>Patch}
     * (which reads a body as a {@code JsonNode}).
     *
     * @throws CanonicalDuration.InvalidDurationException for a node that is not an accepted
     *         duration string
     */
    public static Duration fromNode(JsonNode node) {
        if (node.isTextual()) return CanonicalDuration.parse(node.asText());
        throw new CanonicalDuration.InvalidDurationException("field.duration: not a string: " + node);
    }
}
