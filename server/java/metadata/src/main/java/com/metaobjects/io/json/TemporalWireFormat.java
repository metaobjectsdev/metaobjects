package com.metaobjects.io.json;

import com.metaobjects.field.DateField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.TimestampField;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Date;

/**
 * Shared wire-form contract for {@code DataTypes.DATE} fields ({@code field.date} and
 * {@code field.timestamp}) — used by the Gson serializer/deserializer
 * ({@link com.metaobjects.io.object.gson.MetaObjectSerializer} /
 * {@link com.metaobjects.io.object.gson.MetaObjectDeserializer}) and the streaming
 * {@link com.metaobjects.io.object.json.JsonObjectReader}. One implementation, not three (#275).
 *
 * <p>Per {@code fixtures/persistence-conformance/normalization.md} (the cross-port wire-form
 * source of truth):
 * <ul>
 *   <li>{@code field.date} — calendar date of the instant at UTC: {@code "YYYY-MM-DD"}
 *       (e.g. {@code "2026-06-03"})</li>
 *   <li>{@code field.timestamp} with {@code @localTime: true} — naive wall clock of the
 *       instant at UTC, no {@code Z}: {@code "YYYY-MM-DDTHH:MM:SS[.fff]"}
 *       (e.g. {@code "2026-06-03T14:30:00.123"})</li>
 *   <li>{@code field.timestamp} (default, tz-aware) — UTC instant:
 *       {@code "YYYY-MM-DDTHH:MM:SS[.fff]Z"} (e.g. {@code "2026-06-03T14:30:00.123Z"})</li>
 * </ul>
 * The fraction is millisecond resolution, trailing zeros stripped, and omitted (with its
 * leading {@code .}) entirely when zero: {@code .123}→{@code .123}, {@code .120}→{@code .12},
 * {@code .100}→{@code .1}, {@code .000}→omitted.
 *
 * <p><b>Known bounded caveat:</b> a hand-constructed {@code DateField} value carrying a sub-day
 * time component writes as the calendar date only (truncation on first write, stable
 * thereafter). This matches the shipped OMDB DATE codec, which anchors DATE columns at
 * midnight UTC — not something this class should "fix".
 */
public final class TemporalWireFormat {

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ISO_LOCAL_DATE;
    private static final DateTimeFormatter TIMESTAMP_FMT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");

    private TemporalWireFormat() {}

    /**
     * Write-side: format {@code d} per {@code mf}'s subtype
     * ({@link DateField#SUBTYPE_DATE} / {@link TimestampField#SUBTYPE_TIMESTAMP}) and, for a
     * timestamp, whether {@link TimestampField#ATTR_LOCAL_TIME} is set. All conversion is at
     * {@link ZoneOffset#UTC} from {@code Instant.ofEpochMilli(d.getTime())}.
     *
     * @param mf the field carrying {@code d} (its subtype/attrs pick the wire shape)
     * @param d  the value to format, or {@code null}
     * @return the wire string, or {@code null} if {@code d} is {@code null}
     */
    public static String format(MetaField mf, Date d) {
        if (d == null) return null;

        Instant instant = Instant.ofEpochMilli(d.getTime());

        if (DateField.SUBTYPE_DATE.equals(mf.getSubType())) {
            return instant.atZone(ZoneOffset.UTC).toLocalDate().format(DATE_FMT);
        }

        // The only other DataTypes.DATE-backed subtype is field.timestamp.
        LocalDateTime wallClock = instant.atZone(ZoneOffset.UTC).toLocalDateTime();
        String base = wallClock.format(TIMESTAMP_FMT) + fractionalSuffix(wallClock.getNano());

        boolean localTime = mf.hasMetaAttr(TimestampField.ATTR_LOCAL_TIME)
                && Boolean.parseBoolean(mf.getMetaAttr(TimestampField.ATTR_LOCAL_TIME).getValueAsString());

        return localTime ? base : base + "Z";
    }

    /**
     * Read-side: tolerant parse, tried in order: {@link Instant#parse} (the {@code Z} form),
     * {@link LocalDateTime#parse} anchored at UTC (the no-{@code Z} form), then
     * {@link LocalDate#parse} at midnight UTC (the date-only form).
     *
     * @param s the wire string
     * @return the parsed {@link Date}
     * @throws IllegalArgumentException if none of the three forms parse {@code s}; the message
     *         names the accepted forms. Callers add field context on top (matching each call
     *         site's existing error-wrapping convention), since this helper has no MetaField.
     */
    public static Date parse(String s) {
        try {
            return Date.from(Instant.parse(s));
        } catch (DateTimeParseException eInstant) {
            try {
                return Date.from(LocalDateTime.parse(s).toInstant(ZoneOffset.UTC));
            } catch (DateTimeParseException eLocalDateTime) {
                try {
                    return Date.from(LocalDate.parse(s).atStartOfDay(ZoneOffset.UTC).toInstant());
                } catch (DateTimeParseException eLocalDate) {
                    throw new IllegalArgumentException(
                            "Cannot parse temporal value [" + s + "]; accepted forms are an ISO instant "
                            + "(\"YYYY-MM-DDTHH:MM:SS[.fff]Z\"), a local date-time "
                            + "(\"YYYY-MM-DDTHH:MM:SS[.fff]\"), or a date (\"YYYY-MM-DD\")", eLocalDate);
                }
            }
        }
    }

    /**
     * Millisecond-resolution fraction, trailing zeros stripped, omitted (with its leading
     * {@code .}) when zero. Mirrors {@code Normalization.fractionalSuffix} in
     * {@code integration-tests} ({@code metadata} cannot depend on that test-only module, so
     * this is a fresh implementation of the same rule, not a shared import).
     */
    private static String fractionalSuffix(int nanos) {
        long millis = nanos / 1_000_000L;
        if (millis == 0) return "";
        String s = String.format(java.util.Locale.ROOT, "%03d", millis).replaceAll("0+$", "");
        return "." + s;
    }
}
