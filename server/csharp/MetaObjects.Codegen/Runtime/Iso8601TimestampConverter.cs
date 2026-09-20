// Iso8601TimestampConverter — the wire spelling of a field.timestamp.
//
// `docs/features/api-contract.md` states that a field.timestamp crosses the wire as ISO
// 8601 WITH A TIMEZONE, spelled with the UTC designator. System.Text.Json's default for
// DateTimeOffset is the round-trip form, which renders UTC as `+00:00`:
//
//     default  2026-09-20T12:10:00+00:00
//     contract 2026-09-20T12:10:00Z
//
// Both are valid ISO 8601, which is why this went unnoticed: nothing errored, and the
// permissive "ISO 8601 with timezone" assertions accept either. It matters because the
// SAME timestamptz row is read by five ports and the cross-port gate is a BYTE
// comparison — two renderings of one instant are two different answers.
//
// The generated CRUD handlers deserialize with the app's CONFIGURED SerializerOptions
// precisely so a host registration like this reaches them:
//
//     builder.Services.ConfigureHttpJsonOptions(o =>
//         o.SerializerOptions.Converters.Add(new Iso8601TimestampConverter()));
//
// It was previously hand-written per test host inside the integration-test project —
// where an adopter never sees it, and where the copy did not in fact produce the
// documented spelling (`DateTimeOffset.ToString("o")` keeps the numeric offset even at
// UTC; reaching `Z` needs the UtcDateTime).

using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MetaObjects.Codegen.Runtime;

/// <summary>
/// Reads and writes <see cref="DateTimeOffset"/> in the api contract's wire spelling:
/// ISO 8601, normalized to UTC, with the <c>Z</c> designator.
/// </summary>
public sealed class Iso8601TimestampConverter : JsonConverter<DateTimeOffset>
{
    /// <summary>
    /// Parse any ISO 8601 instant and normalize it to UTC. A value with NO offset is read
    /// as already-UTC rather than as server local time — a naive string means the same
    /// instant whatever machine happens to deserialize it, which is the only reading that
    /// survives five ports on five hosts.
    /// </summary>
    public override DateTimeOffset Read(
        ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var raw = reader.GetString();
        if (raw is null) throw new JsonException("expected an ISO 8601 timestamp string");
        return DateTimeOffset.Parse(
            raw, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
    }

    /// <summary>
    /// Write as UTC with the <c>Z</c> designator, and with fractional seconds only when
    /// the instant HAS them.
    /// <para>
    /// Sub-second precision is emitted at millisecond resolution when non-zero and omitted
    /// entirely when zero, rather than always padding `.000`: a whole-second instant reads
    /// back as the string the client sent it as, so a round-trip is stable and a byte
    /// comparison across ports is not deciding between two spellings of the same value.
    /// </para>
    /// </summary>
    public override void Write(
        Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options)
    {
        // .UtcDateTime, not .ToUniversalTime(): a DateTimeOffset formats its own numeric
        // offset even when that offset is zero, so "o" on a UTC DateTimeOffset still spells
        // +00:00. Only a DateTime with Kind=Utc renders the Z.
        var utc = value.UtcDateTime;
        var format = utc.Millisecond == 0 && utc.Ticks % TimeSpan.TicksPerSecond == 0
            ? "yyyy-MM-dd'T'HH:mm:ss'Z'"
            : "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";
        writer.WriteStringValue(utc.ToString(format, CultureInfo.InvariantCulture));
    }
}
