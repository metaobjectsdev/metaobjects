package com.metaobjects.field;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The shared {@code field.duration} wire vectors ({@code fixtures/duration-wire/vectors.json})
 * against the production helper, {@link DurationWire}.
 */
public class DurationWireVectorsTest {

    private static JsonObject vectors() throws Exception {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures/duration-wire"))) dir = dir.getParent();
        if (dir == null) throw new IllegalStateException("fixtures/duration-wire not found above " + System.getProperty("user.dir"));
        return JsonParser.parseString(Files.readString(dir.resolve("fixtures/duration-wire/vectors.json"))).getAsJsonObject();
    }

    @Test
    public void parseYieldsTheCanonicalForm() throws Exception {
        for (JsonElement e : vectors().getAsJsonArray("parse")) {
            String in = e.getAsJsonObject().get("in").getAsString();
            String out = e.getAsJsonObject().get("out").getAsString();
            assertTrue("accepted: " + in, DurationWire.isDuration(in));
            assertEquals("parse " + in, out, DurationWire.canonicalize(in));
            // The canonical form is a fixed point.
            assertEquals("re-parse " + out, out, DurationWire.canonicalize(out));
        }
    }

    @Test
    public void refusedInputIsRejected() throws Exception {
        for (JsonElement e : vectors().getAsJsonArray("refused")) {
            String in = e.getAsJsonPrimitive().getAsString();
            assertFalse("refused: '" + in + "'", DurationWire.isDuration(in));
            try {
                DurationWire.parse(in);
                fail("parse must refuse '" + in + "'");
            } catch (IllegalArgumentException expected) {
                // refused
            }
        }
    }

    @Test
    public void postgresTextReadsAsTheCanonicalForm() throws Exception {
        for (JsonElement e : vectors().getAsJsonArray("postgres")) {
            String in = e.getAsJsonObject().get("in").getAsString();
            String out = e.getAsJsonObject().get("out").getAsString();
            assertEquals("postgres " + in, out, DurationWire.format(DurationWire.parsePostgres(in)));
            assertEquals("stored " + in, out, DurationWire.canonicalizeStored(in));
        }
    }

    @Test
    public void postgresCalendarIntervalsAreRefused() throws Exception {
        for (JsonElement e : vectors().getAsJsonArray("postgresRefused")) {
            String in = e.getAsJsonPrimitive().getAsString();
            try {
                DurationWire.fromStored(in);
                fail("must refuse the interval '" + in + "'");
            } catch (IllegalArgumentException expected) {
                // refused
            }
        }
    }

    @Test
    public void postgresTextSpelling() throws Exception {
        for (JsonElement e : vectors().getAsJsonArray("postgresText")) {
            String in = e.getAsJsonObject().get("in").getAsString();
            String out = e.getAsJsonObject().get("out").getAsString();
            assertEquals("postgresText " + in, out, DurationWire.formatPostgres(DurationWire.parse(in)));
            // An interval written that way reads back as the canonical value.
            assertEquals("read back " + out, in, DurationWire.format(DurationWire.parsePostgres(out)));
        }
    }

    @Test
    public void formatTruncatesNanosTowardZero() {
        assertEquals("PT1.123456S", DurationWire.format(Duration.ofSeconds(1, 123_456_789)));
        assertEquals("-PT1.123456S", DurationWire.format(Duration.ofSeconds(1, 123_456_789).negated()));
        assertEquals("PT0S", DurationWire.format(Duration.ofNanos(-999)));
        assertEquals("-PT1M30S", DurationWire.format(Duration.ofSeconds(-90)));
    }

    @Test
    public void formattingIgnoresTheDefaultLocalesDigits() {
        java.util.Locale saved = java.util.Locale.getDefault();
        try {
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("ar-EG-u-nu-arab"));
            assertEquals("-PT1M30.000005S", DurationWire.format(Duration.ofSeconds(-90, -5_000)));
            assertEquals("-00:01:30.000005", DurationWire.formatPostgres(Duration.ofSeconds(-90, -5_000)));
        } finally {
            java.util.Locale.setDefault(saved);
        }
    }

    @Test
    public void aDurationValuePastTheSharedBoundIsNotWritten() {
        assertEquals("PT256204778H", DurationWire.format(DurationWire.MAX));
        try {
            DurationWire.format(DurationWire.MAX.plusNanos(1_000));
            fail("one microsecond past the bound must be refused");
        } catch (IllegalArgumentException expected) {
            // refused
        }
    }
}
