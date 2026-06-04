/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.loader.parser.yaml;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.MetaDataFileParser;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.source.JsonPath;
import com.metaobjects.source.YamlPosition;
import com.metaobjects.source.YamlPositions;
import com.metaobjects.source.YamlPositions.PositionMap;
import com.metaobjects.source.YamlPositions.SideTable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.error.YAMLException;
import org.yaml.snakeyaml.nodes.Node;

import java.io.IOException;
import java.io.InputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * YAML authoring front-end: {@code text → desugar → canonical → CanonicalJsonParser.buildTree}.
 *
 * <p>Java port of the TS reference {@code parser-yaml.ts} and the Python sibling
 * {@code parser_yaml.py}. {@code ParserYaml} is the only front-end that should ever
 * see sugared YAML; downstream code (validators, serializer, conformance harness)
 * sees the same canonical-JSON-shaped tree regardless of authoring format. ADR-0006
 * D4: canonical JSON is the cross-language interchange; YAML is a sigil-free
 * authoring front-end.</p>
 *
 * <p>Pipeline:</p>
 * <ol>
 *   <li>Read input stream as UTF-8; strip UTF-8 BOM if present.</li>
 *   <li>{@code new Yaml().load(text)} → raw {@code Map<String, Object>} (SnakeYAML's
 *       core schema; coercion is intentional and reported by D2).</li>
 *   <li>{@link YamlDesugar#desugar} → canonical-JSON-shaped {@link JsonObject} +
 *       collected diagnostics (e.g. {@code ERR_YAML_COERCION}).</li>
 *   <li>{@link CanonicalJsonParser#buildTree} consumes the canonical JSON. Validation
 *       errors raised here (e.g. {@code ERR_BAD_ATTR_VALUE}) are independent of the
 *       desugar errors.</li>
 * </ol>
 *
 * <p>Two entry points:</p>
 * <ul>
 *   <li>{@link #loadFromStream(InputStream)} — single-error contract used by
 *       {@link MetaDataLoader#load(List)}. Surfaces the first desugar error as a
 *       {@link MetaDataException} (or, if none, runs {@code buildTree}).</li>
 *   <li>{@link #parseYamlCollecting(InputStream)} — multi-error contract used by the
 *       YAML conformance harness. Returns the canonical {@link JsonObject} along with
 *       every collected desugar error so the harness can also run {@code buildTree}
 *       and surface the union of error codes.</li>
 * </ul>
 *
 * @since 7.0.0
 */
public final class ParserYaml extends CanonicalJsonParser implements MetaDataFileParser {

    private static final Logger log = LoggerFactory.getLogger(ParserYaml.class);

    /** Build a ParserYaml for the given loader and filename. */
    public ParserYaml(MetaDataLoader loader, String filename) {
        super(loader, filename);
    }

    /**
     * Main entry point used by the loader pipeline. Parses YAML, desugars to canonical
     * JSON, then hands the canonical {@link JsonObject} to
     * {@link CanonicalJsonParser#buildTree}.
     *
     * <p>This is the single-error path: any desugar coercion or structural error is
     * surfaced as a {@link MetaDataException} carrying the desugar's stable error code,
     * which the loader's per-source try/catch then propagates. To collect the full set
     * of desugar diagnostics alongside subsequent validation errors, use
     * {@link #parseYamlCollecting(InputStream)} from the conformance harness.</p>
     */
    @Override
    public void loadFromStream(InputStream is) {
        try {
            YamlResult result = parseYamlCollecting(is);
            if (!result.errors.isEmpty()) {
                YamlDesugar.CollectedError first = result.errors.get(0);
                ErrorCode code = first.code != null ? first.code : ErrorCode.ERR_MALFORMED_YAML;
                throw new MetaDataException(
                    first.message + " (file [" + getFilename() + "])", code);
            }
            // FR5b — pass the flattened JSONPath → YamlPosition map to buildTree
            // so every node's JsonSource carries the optional yamlPosition.
            buildTree(result.canonical, result.positionsByPath);
        } catch (MetaDataException e) {
            throw e;
        } catch (Exception e) {
            throw new MetaDataException(
                "Error loading YAML metadata from file [" + getFilename() + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Front-end + desugar with collected diagnostics: reads {@code is} as UTF-8, strips
     * the UTF-8 BOM if present, runs the SnakeYAML loader, desugars the result to canonical
     * JSON, and returns the canonical {@link JsonObject} along with every collected
     * desugar diagnostic (per-attr coercion errors + structural-shape errors).
     *
     * <p>Independently callable so the YAML conformance harness can run
     * {@code buildTree} on the canonical and union its (validation) errors with the
     * desugar errors here. Mirrors the multi-error result shape used by the TS / Python
     * reference parsers.</p>
     *
     * @param is input stream (closed by this method)
     * @return the canonical JSON object after desugar, plus the collected diagnostics
     * @throws MetaDataException if SnakeYAML rejects the document as invalid YAML
     *         ({@link ErrorCode#ERR_MALFORMED_YAML}) or the I/O fails
     */
    public YamlResult parseYamlCollecting(InputStream is) {
        String content;
        try {
            byte[] bytes = is.readAllBytes();
            content = new String(bytes, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new MetaDataException(
                "Failed to read YAML metadata from file [" + getFilename() + "]: " + e.getMessage(),
                e);
        } finally {
            try { is.close(); } catch (Exception ignore) {}
        }

        // Strip UTF-8 BOM (0xFEFF) — consistent with CanonicalJsonParser.
        if (!content.isEmpty() && content.charAt(0) == '﻿') {
            content = content.substring(1);
        }

        // FR5b — use Yaml.compose() instead of Yaml.load() so each scalar key carries
        // its (line, col) Mark; the desugar's Node-tree path attaches a PositionMap
        // to every wrapper/body JsonObject in a fresh SideTable.
        Node rootNode;
        try {
            rootNode = new Yaml().compose(new StringReader(content));
        } catch (YAMLException ex) {
            throw new MetaDataException(
                "Invalid YAML in file [" + getFilename() + "]: " + ex.getMessage(),
                ErrorCode.ERR_MALFORMED_YAML);
        }

        // ADR-0023 Decision 2 — resolve the registry from the owning loader (which
        // defaults to the sealed defined-provider-set registry), not the polluted
        // global SPI singleton, so YAML default-subtype desugar measures the same
        // vocabulary the loader validates against.
        MetaDataRegistry registry = getLoader().getTypeRegistry();
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(rootNode, registry);

        // FR5b — flatten the per-JsonObject PositionMap side table into a
        // JSONPath-keyed map so the canonical parser (which walks the
        // JsonObject tree node-by-node) can stamp `yamlPosition` on each
        // node's source envelope via O(1) lookup. The keys mirror the path
        // the parser has on its JsonPath.Builder when it reaches each wrapper.
        Map<String, YamlPosition> positionsByPath = new LinkedHashMap<>();
        if (!result.positions.isEmpty()) {
            flattenPositions(result.canonical, "$", result.positions, positionsByPath);
        }

        if (log.isDebugEnabled()) {
            log.debug("Desugared YAML to canonical JSON for file [{}]: {} top-level key(s), {} diagnostic(s), {} position(s)",
                getFilename(), result.canonical.size(), result.errors.size(), positionsByPath.size());
        }
        return new YamlResult(
            result.canonical,
            Collections.unmodifiableList(new ArrayList<>(result.errors)),
            Collections.unmodifiableMap(positionsByPath));
    }

    // ---------------------------------------------------------------------------
    // FR5b — flatten the per-JsonObject PositionMap side table into a
    // JSONPath → YamlPosition map.
    //
    // For each JsonObject in the tree, its PositionMap (if any) holds entries like
    //   { "object.entity" → (4,7), "@filterable" → (5,9), ... }
    // We emit one entry per (parentPath, key) pair, so the canonical parser hits
    // each wrapper-key entry exactly when its JsonPath.Builder reaches that path.
    //
    // Body-key entries (`@filterable` under `object.entity`) are also emitted into
    // the flat map but the canonical parser does not push body keys onto its
    // builder when stamping source on the OWNING node — so they remain available
    // to future tooling via getMap() but the per-node source envelope only
    // benefits from the wrapper-key entries.
    // ---------------------------------------------------------------------------

    private static void flattenPositions(JsonElement node, String parentPath,
                                          SideTable positions,
                                          Map<String, YamlPosition> output) {
        if (node == null || node.isJsonNull()) return;
        if (node.isJsonObject()) {
            JsonObject obj = node.getAsJsonObject();
            PositionMap map = positions.getMap(obj);
            for (Map.Entry<String, JsonElement> e : obj.entrySet()) {
                String key = e.getKey();
                String childPath = parentPath + JsonPath.segmentForKey(key);
                if (map != null) {
                    YamlPosition pos = map.get(key);
                    if (pos != null) {
                        output.put(childPath, pos);
                    }
                }
                flattenPositions(e.getValue(), childPath, positions, output);
            }
            return;
        }
        if (node.isJsonArray()) {
            JsonArray arr = node.getAsJsonArray();
            for (int i = 0; i < arr.size(); i++) {
                String childPath = parentPath + JsonPath.segmentForIndex(i);
                flattenPositions(arr.get(i), childPath, positions, output);
            }
        }
        // Primitives have no descent + no positions.
    }

    /**
     * Combined desugar output — the canonical JSON ready for {@code buildTree}, plus
     * the desugar's collected diagnostics. The conformance harness consumes this so it
     * can union the desugar codes with any subsequent {@code buildTree} validation
     * codes (e.g. {@code ERR_BAD_ATTR_VALUE} on a coerced enum value).
     *
     * <p>FR5b — {@link #positionsByPath} carries the flattened JSONPath →
     * {@link YamlPosition} map; pass it to
     * {@link CanonicalJsonParser#buildTree(JsonObject, Map)} so every node's
     * {@code JsonSource} envelope gets stamped with its source position. Empty
     * when no position info was tracked (e.g. malformed YAML reached buildTree).</p>
     */
    public static final class YamlResult {
        public final JsonObject canonical;
        public final List<YamlDesugar.CollectedError> errors;
        public final Map<String, YamlPosition> positionsByPath;

        public YamlResult(JsonObject canonical, List<YamlDesugar.CollectedError> errors) {
            this(canonical, errors, Collections.emptyMap());
        }

        public YamlResult(JsonObject canonical, List<YamlDesugar.CollectedError> errors,
                          Map<String, YamlPosition> positionsByPath) {
            this.canonical = canonical;
            this.errors = errors;
            this.positionsByPath = positionsByPath;
        }
    }
}
