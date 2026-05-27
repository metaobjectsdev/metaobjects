// FR5c — multi-file overlay merge attribution unit tests (C# port).
//
// Mirrors the TS reference test
// server/typescript/packages/metadata/test/fr5c-merge-attribution.test.ts
//
// Verifies the loader's overlay-merge phase tracks contributors, raises
// ERR_MERGE_CONFLICT on attribute-level conflicts, and emits
// WARN_DUPLICATE_DECLARATION when a second file re-declares a node
// identically. See ADR-0009 and the FR5c plan.

using System.Text.Json;
using MetaObjects.Loader;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Fr5cMergeAttributionTests
{
    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static InMemoryStringSource MkSource(string content, string id) =>
        new(content, id, MetaDataFormat.Json);

    private const string BaseEntity = """
        {
          "metadata.root": {
            "package": "acme",
            "children": [
              { "object.entity": {
                  "name": "Subscriber",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "field.string": { "name": "email" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """;

    private static string BaseEntityWithDescription(string desc) => $$"""
        {
          "metadata.root": {
            "package": "acme",
            "children": [
              { "object.entity": {
                  "name": "Subscriber",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "field.string": { "name": "email", "@description": "{{desc}}" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """;

    private static string BaseEntityWithEmailFieldOnly() => """
        {
          "metadata.root": {
            "package": "acme",
            "children": [
              { "object.entity": {
                  "name": "Subscriber",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "field.string": { "name": "email" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """;

    // -----------------------------------------------------------------------
    // FR5c — merge phase tracks contributors
    // -----------------------------------------------------------------------

    [Fact]
    public void SingleFileLoad_NodeSource_StaysFormatJson_NoMergedSource()
    {
        var res = new MetaDataLoader().Load(new IMetaDataSource[]
        {
            MkSource(BaseEntity, "meta.a.json"),
        });
        Assert.Empty(res.Errors);
        var sub = res.Root.OwnChildByName("Subscriber");
        Assert.NotNull(sub);
        Assert.Equal("json", sub!.Source.Format);
    }

    [Fact]
    public void TwoFilesContribute_SecondWithSemanticChange_ProducesMergedSourceWithBothContributors()
    {
        // File A declares the entity. File B re-opens it via default same-name
        // reuse (no `overlay: true`) and adds @description — that's a real
        // semantic change, so the merged source should list both files.
        string fileA = BaseEntity;
        string fileB = """
            {
              "metadata.root": {
                "package": "acme",
                "children": [
                  { "object.entity": {
                      "name": "Subscriber",
                      "@description": "A newsletter subscriber."
                    }
                  }
                ]
              }
            }
            """;
        var res = new MetaDataLoader().Load(new IMetaDataSource[]
        {
            MkSource(fileA, "meta.a.json"),
            MkSource(fileB, "meta.b.json"),
        });
        Assert.Empty(res.Errors);
        var sub = res.Root.OwnChildByName("Subscriber");
        Assert.NotNull(sub);
        Assert.Equal("merged", sub!.Source.Format);
        var src = Assert.IsType<MergedSource>(sub.Source);
        // Files are alphabetically sorted, per the cross-port contract.
        Assert.Equal(new[] { "meta.a.json", "meta.b.json" }, src.Files.ToArray());
        Assert.Equal(2, src.Contributors.Count);
        Assert.Equal("meta.a.json", src.Contributors[0].File);
        Assert.Equal("overlay-base", src.Contributors[0].Role);
        Assert.Equal("meta.b.json", src.Contributors[1].File);
        Assert.Equal("overlay-extension", src.Contributors[1].Role);
        Assert.Equal("A newsletter subscriber.", sub.OwnAttr("description"));
    }

    [Fact]
    public void ThreeFilesContribute_MergedSourceListsAllThreeAlphabetically()
    {
        string fileA = BaseEntity;
        string fileB = """
            {
              "metadata.root": {
                "package": "acme",
                "children": [
                  { "object.entity": {
                      "name": "Subscriber",
                      "@description": "Subscriber to a newsletter."
                    }
                  }
                ]
              }
            }
            """;
        string fileC = """
            {
              "metadata.root": {
                "package": "acme",
                "children": [
                  { "object.entity": {
                      "name": "Subscriber",
                      "@title": "Subscriber"
                    }
                  }
                ]
              }
            }
            """;
        var res = new MetaDataLoader().Load(new IMetaDataSource[]
        {
            MkSource(fileA, "meta.a.json"),
            MkSource(fileB, "meta.b.json"),
            MkSource(fileC, "meta.c.json"),
        });
        Assert.Empty(res.Errors);
        var sub = res.Root.OwnChildByName("Subscriber");
        var src = Assert.IsType<MergedSource>(sub!.Source);
        Assert.Equal(new[] { "meta.a.json", "meta.b.json", "meta.c.json" }, src.Files.ToArray());
        Assert.Equal("overlay-base", src.Contributors[0].Role);
        Assert.Equal("overlay-extension", src.Contributors[1].Role);
        Assert.Equal("overlay-extension", src.Contributors[2].Role);
    }

    // -----------------------------------------------------------------------
    // FR5c — ERR_MERGE_CONFLICT on conflicting attr values
    // -----------------------------------------------------------------------

    [Fact]
    public void TwoFiles_SameAttr_DifferentNonEmptyValues_RaisesMergeConflict()
    {
        string fileA = BaseEntityWithDescription("Primary email.");
        string fileB = BaseEntityWithDescription("Backup email.");
        var res = new MetaDataLoader().Load(new IMetaDataSource[]
        {
            MkSource(fileA, "meta.a.json"),
            MkSource(fileB, "meta.b.json"),
        });
        var conflicts = res.Errors.Where(e => e.Code == ErrorCode.ERR_MERGE_CONFLICT).ToList();
        Assert.Single(conflicts);
        var env = Assert.IsType<MergedSource>(conflicts[0].Envelope);
        Assert.Equal("merged", env.Format);
        Assert.Equal(new[] { "meta.a.json", "meta.b.json" }, env.Files.ToArray());
        Assert.Equal("overlay-base", env.Contributors[0].Role);
        Assert.Equal("overlay-extension", env.Contributors[1].Role);
        Assert.Contains("@description", env.JsonPath);
    }

    [Fact]
    public void TwoFiles_SameAttr_SameValue_NoMergeConflict()
    {
        string fileA = BaseEntityWithDescription("Email.");
        string fileB = BaseEntityWithDescription("Email.");
        var res = new MetaDataLoader().Load(new IMetaDataSource[]
        {
            MkSource(fileA, "meta.a.json"),
            MkSource(fileB, "meta.b.json"),
        });
        var conflicts = res.Errors.Where(e => e.Code == ErrorCode.ERR_MERGE_CONFLICT).ToList();
        Assert.Empty(conflicts);
    }

    [Fact]
    public void TwoFiles_OnlyOneSideDeclaresAttr_NoMergeConflict()
    {
        string fileA = BaseEntityWithDescription("Email.");
        string fileB = BaseEntityWithEmailFieldOnly();
        var res = new MetaDataLoader().Load(new IMetaDataSource[]
        {
            MkSource(fileA, "meta.a.json"),
            MkSource(fileB, "meta.b.json"),
        });
        var conflicts = res.Errors.Where(e => e.Code == ErrorCode.ERR_MERGE_CONFLICT).ToList();
        Assert.Empty(conflicts);
    }

    // -----------------------------------------------------------------------
    // FR5c — WARN_DUPLICATE_DECLARATION via semantic-diff
    // -----------------------------------------------------------------------

    [Fact]
    public void TwoFilesDeclareSameNodeIdentically_EmitsDuplicateDeclarationWarning()
    {
        // Use an abstract entity (no identity.primary, no anonymous children
        // that would duplicate on a second pass). Two identical declarations
        // from different files should produce no semantic change and emit the
        // duplicate-declaration warning.
        string file = """
            {
              "metadata.root": {
                "package": "acme",
                "children": [
                  { "object.entity": {
                      "name": "Subscriber",
                      "abstract": true,
                      "children": [
                        { "field.long": { "name": "id" } },
                        { "field.string": { "name": "email" } }
                      ]
                    }
                  }
                ]
              }
            }
            """;
        var res = new MetaDataLoader().Load(new IMetaDataSource[]
        {
            MkSource(file, "meta.a.json"),
            MkSource(file, "meta.b.json"),
        });
        Assert.Empty(res.Errors);
        Assert.NotNull(res.EnvelopeWarnings);
        var dups = res.EnvelopeWarnings!
            .Where(w => w.Code == WarningCodes.WARN_DUPLICATE_DECLARATION).ToList();
        Assert.NotEmpty(dups);
        // One of the warnings should target the top-level Subscriber entity.
        var subWarn = dups.FirstOrDefault(w => w.Message.Contains("Subscriber"));
        Assert.NotNull(subWarn);
        var src = Assert.IsType<MergedSource>(subWarn!.Source);
        Assert.Equal(new[] { "meta.a.json", "meta.b.json" }, src.Files.ToArray());
        Assert.Equal("overlay-base", src.Contributors[0].Role);
        Assert.Equal("overlay-extension", src.Contributors[1].Role);
    }

    [Fact]
    public void RealSemanticOverlay_DoesNotEmitDuplicateDeclarationWarning()
    {
        string fileA = BaseEntity;
        string fileB = """
            {
              "metadata.root": {
                "package": "acme",
                "children": [
                  { "object.entity": {
                      "name": "Subscriber",
                      "@description": "Differs from A."
                    }
                  }
                ]
              }
            }
            """;
        var res = new MetaDataLoader().Load(new IMetaDataSource[]
        {
            MkSource(fileA, "meta.a.json"),
            MkSource(fileB, "meta.b.json"),
        });
        Assert.NotNull(res.EnvelopeWarnings);
        var dups = res.EnvelopeWarnings!
            .Where(w => w.Code == WarningCodes.WARN_DUPLICATE_DECLARATION).ToList();
        Assert.Empty(dups);
    }

    // -----------------------------------------------------------------------
    // FR5c — overlay-base/overlay-extension role ordering
    // -----------------------------------------------------------------------

    [Fact]
    public void Contributors_FirstRoleIsOverlayBase_RestAreOverlayExtension()
    {
        string fileA = BaseEntity;
        string fileB = """
            {
              "metadata.root": {
                "package": "acme",
                "children": [
                  { "object.entity": {
                      "name": "Subscriber",
                      "@title": "Subscriber"
                    }
                  }
                ]
              }
            }
            """;
        var res = new MetaDataLoader().Load(new IMetaDataSource[]
        {
            MkSource(fileA, "meta.a.json"),
            MkSource(fileB, "meta.b.json"),
        });
        var sub = res.Root.OwnChildByName("Subscriber")!;
        var src = Assert.IsType<MergedSource>(sub.Source);
        Assert.Equal("overlay-base", src.Contributors[0].Role);
        Assert.Equal("overlay-extension", src.Contributors[1].Role);
    }

    // -----------------------------------------------------------------------
    // FR5c — legacy warnings channel still carries envelope-warning messages
    // (for the conformance runner's expected-warnings.json string check).
    // -----------------------------------------------------------------------

    [Fact]
    public void LegacyStringWarnings_IncludeEnvelopeWarningMessages_ForConformanceRunner()
    {
        string file = """
            {
              "metadata.root": {
                "package": "acme",
                "children": [
                  { "object.entity": {
                      "name": "Subscriber",
                      "abstract": true,
                      "children": [
                        { "field.long": { "name": "id" } }
                      ]
                    }
                  }
                ]
              }
            }
            """;
        var res = new MetaDataLoader().Load(new IMetaDataSource[]
        {
            MkSource(file, "meta.a.json"),
            MkSource(file, "meta.b.json"),
        });
        Assert.Contains(res.Warnings,
            w => w.Contains("duplicate declaration", StringComparison.Ordinal));
    }
}
