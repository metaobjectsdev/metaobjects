// ADR-0062: a file the manifest does not record (one written outside the project root) is part of
// the stored outputs, so a skip needs it to exist.

#nullable enable

using MetaObjects.Codegen;
using Xunit;

public sealed class GenFingerprintUntrackedTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-untracked-" + Guid.NewGuid().ToString("N"));
    private readonly string _outside = Path.Combine(Path.GetTempPath(), "meta-untracked-out-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
        if (Directory.Exists(_outside)) Directory.Delete(_outside, true);
    }

    private string Prepare()
    {
        Directory.CreateDirectory(Path.Combine(_root, "gen"));
        Directory.CreateDirectory(_outside);
        const string content = "// generated\n";
        File.WriteAllText(Path.Combine(_root, "gen", "A.cs"), content);
        var outside = Path.Combine(_outside, "B.cs");
        File.WriteAllText(outside, content);
        HashManifest.Save(Path.Combine(_root, ".metaobjects", ".gen-state"),
            new Dictionary<string, string> { ["gen/A.cs"] = HashManifest.ContentHash(content) });
        GenFingerprint.Write(_root, "model", "identity", [outside]);
        return outside;
    }

    [Fact]
    public void AMissingOutputOutsideTheProjectBlocksTheSkipAndTheLocalNoDriftAnswer()
    {
        var outside = Prepare();
        Assert.True(GenFingerprint.CanSkipGen(_root, "model", "identity"));
        Assert.True(GenFingerprint.MayAnswerNoDrift(_root, "model", "identity", full: false, _ => null));

        File.Delete(outside);

        Assert.False(GenFingerprint.CanSkipGen(_root, "model", "identity"));
        Assert.False(GenFingerprint.MayAnswerNoDrift(_root, "model", "identity", full: false, _ => null));
    }
}
