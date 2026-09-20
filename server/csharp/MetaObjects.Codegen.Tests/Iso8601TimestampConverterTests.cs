// Iso8601TimestampConverter — the field.timestamp wire spelling.
//
// docs/features/api-contract.md pins ISO 8601 with a timezone, spelled with the UTC
// designator. System.Text.Json's default renders UTC as `+00:00` instead, and both forms
// are valid ISO 8601 — which is why this survived: nothing errors, and the permissive
// "ISO 8601 with timezone" assertions accept either. The cross-port gate is a BYTE
// comparison of the same timestamptz row read by five ports, so two spellings are two
// different answers.

using System.Text.Json;
using MetaObjects.Codegen.Runtime;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class Iso8601TimestampConverterTests
{
    private static readonly JsonSerializerOptions Options = Build();

    private static JsonSerializerOptions Build()
    {
        var o = new JsonSerializerOptions();
        o.Converters.Add(new Iso8601TimestampConverter());
        return o;
    }

    private static string Write(DateTimeOffset value) => JsonSerializer.Serialize(value, Options);
    private static DateTimeOffset Read(string json) => JsonSerializer.Deserialize<DateTimeOffset>(json, Options);

    [Fact]
    public void A_utc_instant_writes_the_Z_designator_not_a_zero_offset()
    {
        // The whole point. DateTimeOffset.ToString("o") — including the copy that lived in
        // the integration-test host — writes +00:00 here, because a DateTimeOffset formats
        // its own numeric offset even when that offset is zero.
        Assert.Equal("\"2026-09-20T12:10:00Z\"", Write(new DateTimeOffset(2026, 9, 20, 12, 10, 0, TimeSpan.Zero)));
    }

    [Fact]
    public void A_non_utc_instant_is_normalized_to_utc()
    {
        // Same instant, written the one way: 14:10+02:00 is 12:10Z.
        Assert.Equal(
            "\"2026-09-20T12:10:00Z\"",
            Write(new DateTimeOffset(2026, 9, 20, 14, 10, 0, TimeSpan.FromHours(2))));
    }

    [Fact]
    public void Sub_second_precision_is_kept_at_millisecond_resolution()
    {
        Assert.Equal(
            "\"2026-09-20T12:10:00.123Z\"",
            Write(new DateTimeOffset(2026, 9, 20, 12, 10, 0, 123, TimeSpan.Zero)));
    }

    [Fact]
    public void A_whole_second_round_trips_to_the_string_it_came_from()
    {
        // Stability is the reason `.000` is not padded on: a client sends a whole-second
        // instant and reads back the same bytes, so a cross-port byte comparison is not
        // deciding between two spellings of one value.
        const string wire = "\"2026-09-20T12:10:00Z\"";
        Assert.Equal(wire, Write(Read(wire)));
    }

    [Theory]
    [InlineData("\"2026-09-20T12:10:00Z\"")]
    [InlineData("\"2026-09-20T12:10:00+00:00\"")]
    [InlineData("\"2026-09-20T14:10:00+02:00\"")]
    public void Every_iso_8601_spelling_of_one_instant_reads_as_that_instant(string wire)
    {
        Assert.Equal(new DateTimeOffset(2026, 9, 20, 12, 10, 0, TimeSpan.Zero), Read(wire));
    }

    [Fact]
    public void A_value_with_no_offset_is_read_as_utc_not_as_server_local_time()
    {
        // A naive string must mean the same instant whatever machine deserializes it —
        // the only reading that survives five ports on five hosts. Without
        // AssumeUniversal this is the local time of whoever happened to parse it.
        Assert.Equal(
            new DateTimeOffset(2026, 9, 20, 12, 10, 0, TimeSpan.Zero),
            Read("\"2026-09-20T12:10:00\""));
    }

    [Fact]
    public void A_null_is_a_json_error_not_a_default_instant()
    {
        Assert.Throws<JsonException>(() => Read("null"));
    }
}
