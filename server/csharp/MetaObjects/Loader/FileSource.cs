// FileSource — a metadata source backed by a file on disk.
//
// Ported from typescript/packages/metadata/src/loader/core/file-source.ts

namespace MetaObjects.Loader;

/// <summary>
/// A metadata source backed by a file on disk. The format is inferred from the
/// file extension: <c>.yaml</c> / <c>.yml</c> → <see cref="MetaDataFormat.Yaml"/>,
/// everything else → <see cref="MetaDataFormat.Json"/>.
/// </summary>
public sealed class FileSource : IMetaDataSource
{
    /// <summary>The full path to the backing file.</summary>
    public string FilePath { get; }

    public string Id { get; }

    public MetaDataFormat Format { get; }

    public FileSource(string path)
    {
        FilePath = path;
        Id = System.IO.Path.GetFileName(path);
        string ext = System.IO.Path.GetExtension(path);
        Format = ext.Equals(".yaml", StringComparison.OrdinalIgnoreCase)
                 || ext.Equals(".yml", StringComparison.OrdinalIgnoreCase)
            ? MetaDataFormat.Yaml
            : MetaDataFormat.Json;
    }

    /// <summary>
    /// Read the file content. BOM stripping is handled by the parser, not here.
    /// </summary>
    public string Read() => System.IO.File.ReadAllText(FilePath);
}
