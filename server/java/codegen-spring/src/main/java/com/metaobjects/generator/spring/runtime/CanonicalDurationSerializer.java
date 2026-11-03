package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.ser.std.StdSerializer;

import java.io.IOException;
import java.time.Duration;

/**
 * Jackson serializer for a {@code field.duration} record component: writes the canonical
 * ISO-8601 string ({@link CanonicalDuration#format}). A generated record binds it per component
 * with {@code @JsonSerialize(using = CanonicalDurationSerializer.class)}, so a host
 * {@code ObjectMapper} (whose JavaTimeModule writes a Duration as decimal seconds, or as
 * {@link Duration#toString()}) cannot change the bytes. Null is written by Jackson before this runs.
 */
public final class CanonicalDurationSerializer extends StdSerializer<Duration> {

    private static final long serialVersionUID = 1L;

    public CanonicalDurationSerializer() {
        super(Duration.class);
    }

    @Override
    public void serialize(Duration value, JsonGenerator gen, SerializerProvider provider) throws IOException {
        gen.writeString(CanonicalDuration.format(value));
    }
}
