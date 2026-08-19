using System.IO;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Focused unit coverage for <see cref="NeutralConfig.Read"/> on shapes that are
/// NOT gated by the shared <c>source-resolution-conformance</c> corpus — either
/// because the reference TypeScript implementation deliberately behaves
/// differently (whitespace-only path) or to pin a specific prior defect
/// directly against this port's own code (the schema_version float parse).
/// </summary>
public sealed class NeutralConfigTests
{
    private static string WriteConfig(string payloadJson)
    {
        var dir = Path.Combine(Path.GetTempPath(), "neutral-config-" + System.Guid.NewGuid().ToString("N"));
        var cfgDir = Path.Combine(dir, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        File.WriteAllText(Path.Combine(cfgDir, "config.json"), payloadJson);
        return dir;
    }

    [Fact]
    public void WhitespaceOnlyPath_Raises()
    {
        // Deliberately NOT gated by the shared cross-port corpus: the TS
        // reference (`config.ts`'s `z.string().min(1)`) rejects only a
        // fully-empty path, not a whitespace-only one, and the reference is
        // out of scope to change here. This port is stricter on this one
        // edge case by design.
        var dir = WriteConfig("""{ "schema_version": 1, "sources": [ { "path": "   " } ] }""");
        try
        {
            Assert.ThrowsAny<MetaModelException>(() => NeutralConfig.Read(dir));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void SchemaVersionAsFloatLiteral_IsAcceptedLikeTheOtherThreePorts()
    {
        // Regression pin: `schema_version: 1.0` used to throw a raw, uncoded
        // FormatException from GetInt32() — the other three ports all accept a
        // float-looking `1.0` as equal to the supported version `1`.
        var dir = WriteConfig("""{ "schema_version": 1.0, "sources": [ { "path": "model" } ] }""");
        try
        {
            var cfg = NeutralConfig.Read(dir);
            Assert.NotNull(cfg);
            Assert.Single(cfg!.Sources);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void SchemaVersionNonIntegral_RaisesCodedError_NotFormatException()
    {
        var dir = WriteConfig("""{ "schema_version": 1.5, "sources": [] }""");
        try
        {
            var ex = Assert.ThrowsAny<MetaModelException>(() => NeutralConfig.Read(dir));
            Assert.Equal(ErrorCode.ERR_BAD_ATTR_VALUE, ex.Code);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
