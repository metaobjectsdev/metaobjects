// MetaDataSource — the raw-document unit consumed by the loader pipeline.
//
// Ported from typescript/packages/metadata/src/loader/meta-data-source.ts
//
// The C# loader is synchronous (corpus is tiny; sync I/O keeps the adapter
// simple). Read() returns string, not Task<string>.

namespace MetaObjects.Loader;

/// <summary>Content format of a source — selects the parser.</summary>
public enum MetaDataFormat { Json, Yaml }

/// <summary>One unit of raw metadata input consumed by the loader pipeline.</summary>
public interface IMetaDataSource
{
    /// <summary>Human-readable id — used in parse-error messages (e.g. a filename).</summary>
    string Id { get; }
    /// <summary>Content-format hint — selects the parser.</summary>
    MetaDataFormat Format { get; }
    /// <summary>Resolve the raw content. May perform I/O.</summary>
    string Read();
}

/// <summary>Shared helpers for <see cref="IMetaDataSource"/> implementations.</summary>
internal static class MetaDataFormats
{
    /// <summary>Infer <see cref="MetaDataFormat"/> from a path/URI extension. Unknown → JSON.</summary>
    internal static MetaDataFormat InferFromExtension(string path)
    {
        string ext = System.IO.Path.GetExtension(path);
        return ext.Equals(".yaml", StringComparison.OrdinalIgnoreCase)
               || ext.Equals(".yml", StringComparison.OrdinalIgnoreCase)
            ? MetaDataFormat.Yaml
            : MetaDataFormat.Json;
    }
}

/// <summary>A metadata source backed by an in-memory string.</summary>
public sealed class InMemoryStringSource : IMetaDataSource
{
    private readonly string _content;
    public string Id { get; }
    public MetaDataFormat Format { get; }

    public InMemoryStringSource(string content, string id = "<inline>",
        MetaDataFormat format = MetaDataFormat.Json)
    {
        _content = content ?? throw new ArgumentNullException(nameof(content));
        Id = id ?? "<inline>";
        Format = format;
    }

    public string Read() => _content;
}
