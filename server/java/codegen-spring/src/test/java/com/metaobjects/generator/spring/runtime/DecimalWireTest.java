package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import org.junit.Test;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * ADR-0019 Amendment 1 (W1 to W4): runs every shared vector in
 * {@code fixtures/decimal-wire/vectors.json} against the PRODUCTION helpers the generated DTOs
 * and the generated filter parser call.
 */
public class DecimalWireTest {

    public record Holder(
        @JsonSerialize(using = CanonicalDecimalSerializer.class)
        @JsonDeserialize(using = CanonicalDecimalDeserializer.class)
        BigDecimal v) {}

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static JsonNode vectors() throws IOException {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/decimal-wire/vectors.json"))) p = p.getParent();
        assertNotNull("fixtures/decimal-wire/vectors.json not found above the working directory", p);
        return MAPPER.readTree(p.resolve("fixtures/decimal-wire/vectors.json").toFile());
    }

    @Test
    public void formatVectors() throws IOException {
        for (JsonNode v : vectors().get("format")) {
            BigDecimal in = new BigDecimal(v.get("in").asText());
            String out = v.get("out").asText();
            assertEquals("format " + in, out, CanonicalDecimal.format(in));
            // the Jackson serializer writes exactly that string
            assertEquals("serialize " + in, "{\"v\":\"" + out + "\"}", MAPPER.writeValueAsString(new Holder(in)));
        }
        assertNull(CanonicalDecimal.format(null));
        assertEquals("{\"v\":null}", MAPPER.writeValueAsString(new Holder(null)));
    }

    @Test
    public void parseVectors() throws IOException {
        for (JsonNode v : vectors().get("parse")) {
            String json = v.get("json").asText();
            String body = "{\"v\":" + json + "}";
            if (v.path("error").asBoolean(false)) {
                try {
                    Holder h = MAPPER.readValue(body, Holder.class);
                    fail("expected a refusal for " + json + ", got " + h);
                } catch (IOException expected) {
                    // refused: Spring maps a Jackson read failure to 400
                }
            } else if (v.get("value").isNull()) {
                assertNull("parse " + json, MAPPER.readValue(body, Holder.class).v());
            } else {
                BigDecimal want = new BigDecimal(v.get("value").asText());
                BigDecimal got = MAPPER.readValue(body, Holder.class).v();
                assertEquals("parse " + json + " gave " + got, 0, want.compareTo(got));
            }
        }
    }

    @Test
    public void filterOperandVectors() throws IOException {
        for (JsonNode v : vectors().get("filterOperand")) {
            String text = v.get("text").asText();
            if (v.path("error").asBoolean(false)) {
                assertThrows("operand " + text, CanonicalDecimal.InvalidDecimalException.class,
                    () -> CanonicalDecimal.parseFilterOperand(text));
            } else {
                BigDecimal want = new BigDecimal(v.get("value").asText());
                assertEquals("operand " + text, 0, want.compareTo(CanonicalDecimal.parseFilterOperand(text)));
            }
        }
    }

    @Test
    public void double15Vectors() throws IOException {
        for (JsonNode v : vectors().get("double15")) {
            double d = Double.parseDouble(v.get("double").asText());
            assertEquals("double15 " + d, v.get("out").asText(), CanonicalDecimal.formatDouble15(d));
        }
    }

    @Test
    public void outOfRangeIsAnErrorNotARounding() {
        assertThrows(CanonicalDecimal.InvalidDecimalException.class, () -> CanonicalDecimal.parse("1e999999999"));
        assertThrows(CanonicalDecimal.InvalidDecimalException.class, () -> CanonicalDecimal.parse("1e99999999999"));
        assertThrows(CanonicalDecimal.InvalidDecimalException.class, () -> CanonicalDecimal.parse("1e-99999"));
        assertEquals(0, BigDecimal.ZERO.compareTo(CanonicalDecimal.parse("0e999999999")));
    }

    @Test
    public void aNumberTokenIsExactNotADouble() throws IOException {
        BigDecimal got = MAPPER.readValue("{\"v\":12345678901234567.89}", Holder.class).v();
        assertTrue(got.toString(), new BigDecimal("12345678901234567.89").compareTo(got) == 0);
    }

    public record Bounded(
        @DeclaredDecimal(precision = 12, scale = 2)
        @JsonSerialize(using = CanonicalDecimalSerializer.class)
        @JsonDeserialize(using = CanonicalDecimalDeserializer.class)
        BigDecimal v,
        @DeclaredDecimal(precision = 5, scale = 2)
        @JsonSerialize(contentUsing = CanonicalDecimalSerializer.class)
        @JsonDeserialize(contentUsing = CanonicalDecimalDeserializer.class)
        java.util.List<BigDecimal> items) {}

    @Test
    public void aDeclaredColumnBoundsWhatTheDeserializerAccepts() throws IOException {
        // W3 on input: fits decimal(12,2); trailing zeros and a 10-digit integer part are fine.
        assertEquals(0, new BigDecimal("1234567890.12").compareTo(
            MAPPER.readValue("{\"v\":\"1234567890.12\"}", Bounded.class).v()));
        assertEquals(0, new BigDecimal("1.5").compareTo(
            MAPPER.readValue("{\"v\":\"1.5000000\"}", Bounded.class).v()));
        assertEquals(0, new BigDecimal("15").compareTo(MAPPER.readValue("{\"v\":\"1.5e1\"}", Bounded.class).v()));
        // ...a third fraction digit, an 11th integer digit, and the same through a JSON number: 400.
        for (String bad : new String[] { "\"0.123\"", "\"12345678901.1\"", "0.123", "1e11", "1e-3" }) {
            assertThrows(bad, IOException.class, () -> MAPPER.readValue("{\"v\":" + bad + "}", Bounded.class));
        }
        // each element of a list is bounded by the same declaration
        assertThrows(IOException.class, () -> MAPPER.readValue("{\"items\":[\"1\",\"0.001\"]}", Bounded.class));
        assertEquals(2, MAPPER.readValue("{\"items\":[\"1\",\"999.99\"]}", Bounded.class).items().size());
    }

    @Test
    public void aPatchNodeIsBoundedTheSameWay() {
        assertEquals(0, new BigDecimal("0.12").compareTo(
            CanonicalDecimalDeserializer.fromNode(MAPPER.getNodeFactory().textNode("0.1200"), 12, 2)));
        assertThrows(CanonicalDecimal.InvalidDecimalException.class,
            () -> CanonicalDecimalDeserializer.fromNode(MAPPER.getNodeFactory().textNode("0.123"), 12, 2));
        assertThrows(CanonicalDecimal.InvalidDecimalException.class,
            () -> CanonicalDecimalDeserializer.fromNode(MAPPER.getNodeFactory().numberNode(new BigDecimal("1e12")), 12, 2));
    }
}
