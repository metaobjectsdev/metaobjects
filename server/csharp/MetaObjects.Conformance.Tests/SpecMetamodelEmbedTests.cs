// FR-033 byte-identity gate — the spec/metamodel/*.json embedded into the MetaObjects
// assembly (as EmbeddedResource) must be byte-for-byte identical to the repo-root
// source. The descriptions are the cross-port single source of truth; a silently-stale
// embedded copy would let the C# port drift from TS undetected. (Newline-normalized so
// a CRLF checkout can't mask a real divergence.)
//
// REFRESH STEP: when the repo-root spec/metamodel/*.json change, re-copy them with
//   cp spec/metamodel/*.json server/csharp/MetaObjects/SpecMetamodel/
// then rebuild; this gate fails until the embedded copies match.

using System.Reflection;
using MetaObjects.Registry.Spec;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SpecMetamodelEmbedTests
{
    [Fact]
    public void Embedded_spec_files_match_repo_root_source_byte_for_byte()
    {
        string specDir = RepoRootSpecDir();
        Assembly asm = typeof(SpecMetamodelReader).Assembly;

        foreach (string file in SpecMetamodelReader.SpecFiles)
        {
            string resource = SpecMetamodelReader.ResourcePrefix + file;
            using Stream? stream = asm.GetManifestResourceStream(resource);
            Assert.True(stream is not null,
                $"Embedded spec file missing from the assembly: {resource} " +
                "(it must be committed under MetaObjects/SpecMetamodel/ and marked <EmbeddedResource>).");

            using var sr = new StreamReader(stream!);
            string embedded = sr.ReadToEnd();
            string source = File.ReadAllText(Path.Combine(specDir, file));

            Assert.True(Normalize(embedded) == Normalize(source),
                $"Embedded spec/metamodel/{file} diverges from the repo-root source " +
                "(FR-033 single-source rule). Re-copy: cp spec/metamodel/*.json " +
                "server/csharp/MetaObjects/SpecMetamodel/");
        }
    }

    [Fact]
    public void Embedded_file_set_matches_the_repo_root_directory()
    {
        string specDir = RepoRootSpecDir();
        var onDisk = Directory.GetFiles(specDir, "*.json")
            .Select(p => Path.GetFileName(p)!)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        var declared = SpecMetamodelReader.SpecFiles.OrderBy(n => n, StringComparer.Ordinal).ToList();
        Assert.Equal(declared, onDisk);
    }

    [Fact]
    public void Reader_loads_every_embedded_file()
    {
        // Smoke: the reader parses all 16 files off the assembly without throwing and
        // exposes a non-trivial set of type docs + the common-attr docs.
        SpecMetamodelReader reader = SpecMetamodelReader.Load();
        Assert.NotNull(reader.CommonAttrDoc("description"));
        Assert.NotNull(reader.TypeDoc("field", "string"));
        Assert.NotNull(reader.AttrDoc("field", "string", "maxLength"));
    }

    private static string Normalize(string s) => s.Replace("\r\n", "\n");

    private static string RepoRootSpecDir()
    {
        // CorpusRoot.Path is <repo>/fixtures/conformance; spec/metamodel/ is a
        // sibling of fixtures/ under the repo root.
        string repoRoot = Path.GetDirectoryName(Path.GetDirectoryName(CorpusRoot.Path)!)!;
        return Path.Combine(repoRoot, "spec", "metamodel");
    }
}
