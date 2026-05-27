// ParserYaml — YAML authoring front-end (ADR-0006).
//
// C# port of:
//   server/typescript/packages/metadata/src/core/parser-yaml.ts  (reference)
//   server/python/src/metaobjects/parser_yaml.py                 (sibling)
//   server/java/metadata/src/main/java/com/metaobjects/loader/parser/yaml/ParserYaml.java
//
// Pipeline:
//   1. Read text as UTF-8; strip UTF-8 BOM if present.
//   2. YamlDotNet's YamlStream parses YAML → YamlDocument(s).
//   3. YamlDesugar.Desugar lowers the YAML representation to canonical-JSON
//      (a JsonObject) + collected diagnostics (e.g. ERR_YAML_COERCION).
//   4. The canonical JSON is serialized and handed to Parser.ParseJson, which
//      runs the registry-driven canonical buildTree pipeline.
//
// Two entry points:
//   - ParseYaml(content, opts)           — single-result API, mirrors ParseJson.
//   - ParseYamlCollecting(content, opts) — multi-error API, used by the YAML
//                                          conformance harness.

using System.Text.Json.Nodes;
using MetaObjects.Loader;
using MetaObjects.Source;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace MetaObjects;

/// <summary>
/// Combined desugar output — the canonical JSON ready for buildTree, plus the
/// desugar's collected diagnostics and the flattened JSONPath-keyed YAML
/// position map (FR5b). The conformance harness uses this to union the desugar
/// codes with any subsequent buildTree validation codes and to pass positions
/// through <see cref="ParseOptions.YamlPositionsByPath"/> on the second-leg
/// canonical parse.
/// </summary>
public sealed record YamlParseCollectingResult(
    JsonObject Canonical,
    IReadOnlyList<YamlCollectedError> Errors,
    IReadOnlyDictionary<string, YamlPosition> PositionsByPath);

/// <summary>
/// YAML authoring front-end. Entry point: <see cref="ParseYaml"/>.
/// </summary>
public static class ParserYaml
{
    /// <summary>
    /// Parse a YAML metadata document into a typed MetaData tree.
    /// Desugars to canonical JSON, then runs the registry-driven canonical parser.
    /// Surfaces the first desugar diagnostic (if any) as a <see cref="ParseException"/>
    /// carrying that diagnostic's stable code; otherwise behaves like
    /// <see cref="Parser.ParseJson"/>.
    /// </summary>
    /// <exception cref="ParseException">
    /// On malformed YAML (<see cref="ErrorCode.ERR_MALFORMED_YAML"/>), a YAML
    /// coercion that the desugar collected as its first diagnostic
    /// (<see cref="ErrorCode.ERR_YAML_COERCION"/>), or any top-level structural
    /// failure the canonical parser also throws on.
    /// </exception>
    public static ParseResult ParseYaml(string content, ParseOptions opts)
    {
        YamlParseCollectingResult collected = ParseYamlCollecting(content, opts);

        if (collected.Errors.Count > 0)
        {
            YamlCollectedError first = collected.Errors[0];
            throw new ParseException(
                first.Message,
                first.Code ?? ErrorCode.ERR_MALFORMED_YAML,
                opts.SourceName,
                null);
        }

        // Hand the canonical JSON to the existing canonical parser.
        // ToJsonString() emits standard JSON; round-trip is byte-safe for the
        // shapes the desugar produces (strings/numbers/bools/null/objects/arrays).
        // FR5b — pass the desugar's flattened JSONPath→YamlPosition map so the
        // canonical parser stamps `yamlPosition` (and `format: "yaml"`) on
        // every constructed node's source envelope.
        string canonicalJson = collected.Canonical.ToJsonString();
        var yamlOpts = new ParseOptions(opts.Registry)
        {
            Strict = opts.Strict,
            SourceName = opts.SourceName,
            IntoRoot = opts.IntoRoot,
            DeferSuperResolution = opts.DeferSuperResolution,
            SourceFormat = MetaDataFormat.Yaml,
            YamlPositionsByPath = collected.PositionsByPath,
        };
        return Parser.ParseJson(canonicalJson, yamlOpts);
    }

    // -------------------------------------------------------------------------
    // FR5b position flattening
    //
    // Walk the desugar's canonical JsonObject and emit JSONPath→YamlPosition
    // entries for every wrapper-key in the tree. The canonical structure is:
    //
    //   {"metadata.root":{"package":..., "children":[
    //     {"object.entity":{"name":..., "children":[
    //       {"field.string":{"name":...}}
    //     ]}}
    //   ]}}
    //
    // For each JsonObject in the tree, its position map (if any) carries
    // entries like {"object.entity":(4,7)}. We emit:
    //   $.metadata.root          → wrapper-key position of "metadata.root"
    //   $.metadata.root.children[0].object.entity → position of "object.entity"
    //   $.metadata.root.children[0].object.entity.children[0].field.string → ...
    //
    // The body keys (`package`, `name`, etc.) are also in the position maps
    // (carried by the desugar across Rule-5 sigil-free rewrites), but the
    // canonical parser does NOT push body keys onto its JsonPathBuilder when
    // stamping source on the OWNING node — so we only need the wrapper-key
    // entries for the per-node source envelope. Body-key positions remain
    // available to future tooling via YamlPositions.GetMap (the side table is
    // still attached to each JsonObject).
    // -------------------------------------------------------------------------

    private static void FlattenPositions(
        JsonNode? node,
        string parentPath,
        Dictionary<string, YamlPosition> output)
    {
        if (node is null) return;
        if (node is JsonObject obj)
        {
            PositionMap? map = YamlPositions.GetMap(obj);
            foreach (KeyValuePair<string, JsonNode?> kvp in obj)
            {
                string key = kvp.Key;
                string keySegment = JsonPath.SegmentForKey(key);
                string childPath = parentPath + keySegment;
                // Emit a position entry for every wrapper-key that the desugar
                // recorded a position for. The parser's JsonPathBuilder will
                // hit `childPath` precisely when it reaches that wrapper-key,
                // so populateNodeSource can stamp the position on the node it
                // is about to construct.
                YamlPosition? pos = map?.Get(key);
                if (pos is not null)
                {
                    output[childPath] = pos;
                }
                FlattenPositions(kvp.Value, childPath, output);
            }
            return;
        }
        if (node is JsonArray arr)
        {
            for (int i = 0; i < arr.Count; i++)
            {
                string childPath = parentPath + JsonPath.SegmentForIndex(i);
                FlattenPositions(arr[i], childPath, output);
            }
            return;
        }
        // JsonValue (scalar) — no descent, no positions.
    }

    /// <summary>
    /// Front-end + desugar with collected diagnostics: reads <paramref name="content"/>
    /// (with BOM stripping), runs the YamlDotNet loader, desugars the result to canonical
    /// JSON, and returns the canonical <see cref="JsonObject"/> along with every collected
    /// desugar diagnostic. Independently callable so the YAML conformance harness can
    /// run <see cref="Parser.ParseJson"/> on the canonical and union its (validation)
    /// errors with the desugar errors here. Mirrors the multi-error result shape used
    /// by the TS / Python / Java reference parsers.
    /// </summary>
    /// <exception cref="ParseException">
    /// On YamlDotNet rejecting the document as invalid YAML
    /// (<see cref="ErrorCode.ERR_MALFORMED_YAML"/>).
    /// </exception>
    public static YamlParseCollectingResult ParseYamlCollecting(string content, ParseOptions opts)
    {
        // Strip UTF-8 BOM (consistent with Parser.ParseJson).
        string normalized = content.Length > 0 && content[0] == '﻿'
            ? content[1..]
            : content;

        YamlStream stream;
        try
        {
            stream = new YamlStream();
            using var reader = new StringReader(normalized);
            stream.Load(reader);
        }
        catch (YamlException ex)
        {
            throw new ParseException(
                $"Invalid YAML: {ex.Message}",
                ErrorCode.ERR_MALFORMED_YAML,
                opts.SourceName,
                null);
        }
        catch (Exception ex)
        {
            // Defensive — anything YamlDotNet bubbles up that isn't a YamlException.
            throw new ParseException(
                $"Invalid YAML: {ex.Message}",
                ErrorCode.ERR_MALFORMED_YAML,
                opts.SourceName,
                null);
        }

        // Empty document — synthesize an empty mapping so the desugar collects a
        // graceful "must be a mapping" error rather than throwing.
        YamlNode? root = stream.Documents.Count > 0 ? stream.Documents[0].RootNode : null;

        YamlDesugarResult desugared = YamlDesugar.Desugar(root, opts.Registry);

        // FR5b — flatten the per-JsonObject PositionMap side-table into a
        // JSONPath-keyed dictionary so the canonical parser can stamp source
        // envelopes via O(1) lookup.
        var positionsByPath = new Dictionary<string, YamlPosition>(StringComparer.Ordinal);
        FlattenPositions(desugared.Canonical, parentPath: "$", positionsByPath);

        return new YamlParseCollectingResult(desugared.Canonical, desugared.Errors, positionsByPath);
    }
}
