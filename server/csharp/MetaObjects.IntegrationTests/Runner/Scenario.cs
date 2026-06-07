// Scenario records — the typed in-memory shape of a fixture YAML file.
//
// QueryScenario exercises the runtime/persistence layer against the canonical schema.
//
// ScenarioLoader parses YAML into these records. The runners consume them.

using YamlDotNet.RepresentationModel;

namespace MetaObjects.IntegrationTests.Runner;

/// <summary>Base type for any scenario in the corpus.</summary>
public abstract record Scenario(string Name, string Description, string SourcePath);

/// <summary>A query scenario from <c>fixtures/persistence-conformance/queries/</c>.</summary>
public sealed record QueryScenario(
    string Name,
    string Description,
    string SourcePath,
    string? SeedData,
    IReadOnlyList<QuerySpec> Queries)
    : Scenario(Name, Description, SourcePath);

/// <summary>A single query intent: op + entity + filter/sort/by + expected result.</summary>
public sealed record QuerySpec(
    string Name,
    string Op,                                // list | get | count | relate | create | update | delete | roundtrip
    string Entity,
    IReadOnlyDictionary<string, object?>? By, // for op: get / update / delete / relate (the record key)
    IReadOnlyDictionary<string, object?>? Filter,
    IReadOnlyList<SortSpec>? Sort,
    int? Limit,
    int? Offset,
    string? Relation,                         // for op: relate — the relationship name to traverse
    YamlNode? Data,                           // for op: create / update — the field values to write (raw YAML, scalar style preserved)
    bool ExpectError,                         // when true the op MUST throw/reject (cross-subtype writes)
    YamlNode? Insert,                         // for op: roundtrip — the field-keyed row to WRITE (raw YAML, scalar style preserved)
    YamlNode? Expect);                        // raw YAML subtree (scalar style preserved); shape depends on Op

public sealed record SortSpec(string Field, string Dir);   // dir: asc | desc
