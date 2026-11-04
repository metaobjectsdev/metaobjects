package com.metaobjects.field;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.temporal.ChronoUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The shared {@code field.duration} vectors ({@code fixtures/duration-wire/vectors.json}) against
 * the production helper, {@link DurationWire}: every {@code wire} group, at this port's precision
 * ({@code "9"}: a {@link Duration} holds nanoseconds), and the {@code codecs} groups OMDB uses in
 * production — {@code JdbcCodecs.DurationCodec} reads a Postgres interval as its text
 * ({@code postgres}, {@code postgresRefused}), {@code PostgresDriver} binds the interval spelling
 * ({@code postgresText}), and SQLite / MySQL store a microsecond count ({@code storedMicros}).
 */
public class DurationWireVectorsTest {

    /** This port's key in {@code wire.precision[].out}: java.time.Duration holds nine fractional digits. */
    private static final String PRECISION = "9";

    private static JsonObject file() throws Exception {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures/duration-wire"))) dir = dir.getParent();
        if (dir == null) throw new IllegalStateException("fixtures/duration-wire not found above " + System.getProperty("user.dir"));
        return JsonParser.parseString(Files.readString(dir.resolve("fixtures/duration-wire/vectors.json"))).getAsJsonObject();
    }

    private static JsonObject wire() throws Exception {
        return file().getAsJsonObject("wire");
    }

    private static JsonObject codecs() throws Exception {
        return file().getAsJsonObject("codecs");
    }

    @Test
    public void parseYieldsTheCanonicalForm() throws Exception {
        for (JsonElement e : wire().getAsJsonArray("parse")) {
            String in = e.getAsJsonObject().get("in").getAsString();
            String out = e.getAsJsonObject().get("out").getAsString();
            assertTrue("accepted: " + in, DurationWire.isDuration(in));
            assertEquals("parse " + in, out, DurationWire.canonicalize(in));
            // The canonical form is a fixed point.
            assertEquals("re-parse " + out, out, DurationWire.canonicalize(out));
        }
    }

    @Test
    public void precisionKeepsNineDigitsAndTruncatesTheRestTowardZero() throws Exception {
        for (JsonElement e : wire().getAsJsonArray("precision")) {
            String in = e.getAsJsonObject().get("in").getAsString();
            String out = e.getAsJsonObject().getAsJsonObject("out").get(PRECISION).getAsString();
            assertTrue("accepted: " + in, DurationWire.isDuration(in));
            assertEquals("precision " + in, out, DurationWire.canonicalize(in));
            assertEquals("re-parse " + out, out, DurationWire.canonicalize(out));
        }
    }

    @Test
    public void refusedInputIsRejected() throws Exception {
        for (JsonElement e : wire().getAsJsonArray("refused")) {
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
        for (JsonElement e : codecs().getAsJsonArray("postgres")) {
            String in = e.getAsJsonObject().get("in").getAsString();
            String out = e.getAsJsonObject().get("out").getAsString();
            assertEquals("postgres " + in, out, DurationWire.format(DurationWire.parsePostgres(in)));
            assertEquals("stored " + in, out, DurationWire.canonicalizeStored(in));
        }
    }

    @Test
    public void postgresCalendarIntervalsAreRefused() throws Exception {
        for (JsonElement e : codecs().getAsJsonArray("postgresRefused")) {
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
        for (JsonElement e : codecs().getAsJsonArray("postgresText")) {
            String in = e.getAsJsonObject().get("in").getAsString();
            String out = e.getAsJsonObject().get("out").getAsString();
            assertEquals("postgresText " + in, out, DurationWire.formatPostgres(DurationWire.parse(in)));
            // An interval written that way reads back as the canonical value.
            assertEquals("read back " + out, in, DurationWire.format(DurationWire.parsePostgres(out)));
        }
    }

    @Test
    public void formatKeepsNanosAndTheStoredFormsTruncateToMicros() {
        assertEquals("PT1.123456789S", DurationWire.format(Duration.ofSeconds(1, 123_456_789)));
        assertEquals("-PT1.123456789S", DurationWire.format(Duration.ofSeconds(1, 123_456_789).negated()));
        assertEquals("-PT0.000000999S", DurationWire.format(Duration.ofNanos(-999)));
        assertEquals("-PT1M30S", DurationWire.format(Duration.ofSeconds(-90)));
        // A Postgres interval holds microseconds: the interval spelling truncates toward zero.
        assertEquals("00:00:01.123456", DurationWire.formatPostgres(Duration.ofSeconds(1, 123_456_789)));
        assertEquals("-00:00:01.123456", DurationWire.formatPostgres(Duration.ofSeconds(1, 123_456_789).negated()));
        assertEquals("00:00:00", DurationWire.formatPostgres(Duration.ofNanos(-999)));
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
    public void storedMicrosVectors() throws Exception {
        for (JsonElement e : codecs().getAsJsonArray("storedMicros")) {
            String in = e.getAsJsonObject().get("in").getAsString();
            long out = Long.parseLong(e.getAsJsonObject().get("out").getAsString());
            Duration d = DurationWire.parse(in);
            assertEquals("micros " + in, out, DurationWire.toMicros(d));
            // The stored count reads back as the value truncated to microseconds, toward zero.
            assertEquals("from micros " + out, DurationWire.format(d.truncatedTo(ChronoUnit.MICROS)),
                DurationWire.format(DurationWire.fromMicros(out)));
        }
        // Sub-microsecond precision truncates toward zero on both sides of zero.
        assertEquals(-1_000_000L, DurationWire.toMicros(Duration.ofSeconds(-1, -500)));
        assertEquals(1_000_000L, DurationWire.toMicros(Duration.ofSeconds(1, 500)));
    }

    @Test
    public void javaDurationsOwnRangeIsTheOnlyLimitAndIsRefusedNeverWrapped() {
        // Far past any other port's range: Java takes it.
        assertEquals("PT2562047788015215H", DurationWire.canonicalize("PT2562047788015215H"));
        // Past a long count of seconds: refused, never wrapped.
        for (String tooLong : new String[]{"PT9223372036854775808S", "P106751991167301D", "PT99999999999999999999H"}) {
            assertFalse(tooLong, DurationWire.isDuration(tooLong));
            try {
                DurationWire.parse(tooLong);
                fail("must refuse " + tooLong);
            } catch (IllegalArgumentException expected) {
                // refused
            }
        }
        // A BIGINT column holds about 292,000 years of microseconds: past it, the write is refused.
        try {
            DurationWire.toMicros(Duration.ofSeconds(Long.MAX_VALUE / 1_000_000L + 1));
            fail("past a 64-bit microsecond count must be refused");
        } catch (IllegalArgumentException expected) {
            // refused
        }
    }
}
