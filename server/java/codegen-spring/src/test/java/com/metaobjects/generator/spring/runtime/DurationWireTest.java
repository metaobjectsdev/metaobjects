package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The shared {@code fixtures/duration-wire/vectors.json} {@code parse} and {@code refused} vectors
 * against the PRODUCTION helpers a generated record binds ({@link CanonicalDuration} through
 * {@link CanonicalDurationSerializer} / {@link CanonicalDurationDeserializer}). The Postgres
 * vectors belong to the persistence side ({@code com.metaobjects.field.DurationWire}).
 */
public class DurationWireTest {

    public record Holder(
        @JsonSerialize(using = CanonicalDurationSerializer.class)
        @JsonDeserialize(using = CanonicalDurationDeserializer.class)
        Duration v) {}

    /** A plain mapper — no JavaTimeModule: the per-component binding carries the whole rule. */
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static JsonNode vectors() throws IOException {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/duration-wire/vectors.json"))) p = p.getParent();
        assertNotNull("fixtures/duration-wire/vectors.json not found above the working directory", p);
        return MAPPER.readTree(p.resolve("fixtures/duration-wire/vectors.json").toFile());
    }

    @Test
    public void parseVectorsRoundTripThroughTheRecordBinding() throws Exception {
        for (JsonNode v : vectors().get("parse")) {
            String in = v.get("in").asText();
            String out = v.get("out").asText();
            assertEquals("format(parse(" + in + "))", out, CanonicalDuration.format(CanonicalDuration.parse(in)));
            Holder h = MAPPER.readValue("{\"v\":" + MAPPER.writeValueAsString(in) + "}", Holder.class);
            assertEquals("wire " + in, "{\"v\":\"" + out + "\"}", MAPPER.writeValueAsString(h));
        }
    }

    @Test
    public void refusedVectorsAreA400AtTheBindTier() throws Exception {
        for (JsonNode v : vectors().get("refused")) {
            String in = v.asText();
            assertFalse("refused: '" + in + "'", CanonicalDuration.isDuration(in));
            try {
                MAPPER.readValue("{\"v\":" + MAPPER.writeValueAsString(in) + "}", Holder.class);
                fail("must refuse '" + in + "'");
            } catch (com.fasterxml.jackson.databind.JsonMappingException expected) {
                // refused at bind
            }
        }
    }

    @Test
    public void aNumberOfSecondsIsNotADuration() throws Exception {
        try {
            MAPPER.readValue("{\"v\":5400}", Holder.class);
            fail("a JSON number must be refused");
        } catch (com.fasterxml.jackson.databind.JsonMappingException expected) {
            // refused
        }
        assertTrue(MAPPER.readValue("{\"v\":null}", Holder.class).v() == null);
    }

    @Test
    public void nanosTruncateTowardZero() {
        assertEquals("-PT1.123456S", CanonicalDuration.format(Duration.ofSeconds(-1, -123_456_789)));
        assertEquals("PT0S", CanonicalDuration.format(Duration.ofNanos(999)));
    }

    @Test
    public void formattingIgnoresTheDefaultLocalesDigits() throws Exception {
        java.util.Locale saved = java.util.Locale.getDefault();
        try {
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("ar-EG-u-nu-arab"));
            assertEquals("{\"v\":\"-PT1M30.000005S\"}",
                MAPPER.writeValueAsString(new Holder(Duration.ofSeconds(-90, -5_000))));
        } finally {
            java.util.Locale.setDefault(saved);
        }
    }

    @Test
    public void javaDurationsOwnRangeIsTheOnlyLimit() {
        assertEquals("PT2562047788015215H", CanonicalDuration.format(CanonicalDuration.parse("PT2562047788015215H")));
        for (String tooLong : new String[]{"PT9223372036854775808S", "PT99999999999999999999H"}) {
            assertFalse(tooLong, CanonicalDuration.isDuration(tooLong));
            try {
                CanonicalDuration.parse(tooLong);
                fail("must refuse, never wrap: " + tooLong);
            } catch (CanonicalDuration.InvalidDurationException expected) {
                // refused
            }
        }
    }
}
