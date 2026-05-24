/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.loader.parser.yaml;

import com.google.gson.JsonObject;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.MetaDataFileParser;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.error.YAMLException;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

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
            buildTree(result.canonical);
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

        Object parsed;
        try {
            // SnakeYAML's default Yaml() returns LinkedHashMap for mappings, ArrayList
            // for sequences, plus boxed scalars — exactly the input shape
            // YamlDesugar.desugar expects.
            parsed = new Yaml().load(content);
        } catch (YAMLException ex) {
            throw new MetaDataException(
                "Invalid YAML in file [" + getFilename() + "]: " + ex.getMessage(),
                ErrorCode.ERR_MALFORMED_YAML);
        }

        MetaDataRegistry registry = MetaDataRegistry.getInstance();
        YamlDesugar.DesugarResult result = YamlDesugar.desugar(parsed, registry);

        if (log.isDebugEnabled()) {
            log.debug("Desugared YAML to canonical JSON for file [{}]: {} top-level key(s), {} diagnostic(s)",
                getFilename(), result.canonical.size(), result.errors.size());
        }
        return new YamlResult(result.canonical,
            Collections.unmodifiableList(new ArrayList<>(result.errors)));
    }

    /**
     * Combined desugar output — the canonical JSON ready for {@code buildTree}, plus
     * the desugar's collected diagnostics. The conformance harness consumes this so it
     * can union the desugar codes with any subsequent {@code buildTree} validation
     * codes (e.g. {@code ERR_BAD_ATTR_VALUE} on a coerced enum value).
     */
    public static final class YamlResult {
        public final JsonObject canonical;
        public final List<YamlDesugar.CollectedError> errors;

        public YamlResult(JsonObject canonical, List<YamlDesugar.CollectedError> errors) {
            this.canonical = canonical;
            this.errors = errors;
        }
    }
}
