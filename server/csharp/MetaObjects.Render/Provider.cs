// A provider resolves a 2-layer logical reference (`group/source`) to template
// text. The render engine never does I/O itself — it delegates resolution to
// the injected provider, so a fixed provider makes Render() deterministic.
//
// Ported from typescript/packages/render/src/provider.ts.

namespace MetaObjects.Render;

/// <summary>Resolves a <c>group/source</c> reference to its text, or null if absent.</summary>
public interface IProvider
{
    /// <summary>Resolve a <c>group/source</c> reference to its text, or null if absent.</summary>
    string? Resolve(string reference);
}

/// <summary>Deterministic, in-memory provider (the conformance + test provider).</summary>
public sealed class InMemoryProvider(IReadOnlyDictionary<string, string> map) : IProvider
{
    private readonly IReadOnlyDictionary<string, string> _map = map;

    public string? Resolve(string reference) =>
        _map.TryGetValue(reference, out var text) ? text : null;
}
