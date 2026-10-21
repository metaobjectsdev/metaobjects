package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.ser.std.StdSerializer;

import java.io.IOException;
import java.math.BigDecimal;

/**
 * Jackson serializer for a decimal record component: writes the W1 canonical string
 * ({@link CanonicalDecimal#format(BigDecimal)}). A generated DTO binds it per component with
 * {@code @JsonSerialize(using = CanonicalDecimalSerializer.class)}, so a host's
 * {@code ObjectMapper} options cannot change the bytes. Null is written as {@code null} by
 * Jackson before this runs.
 */
public final class CanonicalDecimalSerializer extends StdSerializer<BigDecimal> {

    private static final long serialVersionUID = 1L;

    public CanonicalDecimalSerializer() {
        super(BigDecimal.class);
    }

    @Override
    public void serialize(BigDecimal value, JsonGenerator gen, SerializerProvider provider) throws IOException {
        gen.writeString(CanonicalDecimal.format(value));
    }
}
