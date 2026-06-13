package com.metaobjects.loader.parser.json;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaDataNotFoundException;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.source.Contributor;
import com.metaobjects.source.ErrorSource;
import com.metaobjects.source.JsonPath;
import com.metaobjects.source.JsonSource;
import com.metaobjects.source.LoaderWarning;
import com.metaobjects.source.MergedSource;
import com.metaobjects.source.SemanticDiff;
import com.metaobjects.source.YamlPosition;
import com.metaobjects.source.YamlSource;
import com.metaobjects.util.ErrorMessageConstants;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.BaseMetaDataParser;
import com.metaobjects.loader.parser.MetaDataFileParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Canonical JSON reader for the MetaObjects canonical format.
 *
 * <p>Reads the canonical fused-key JSON format into a {@code MetaRoot} tree.
 * Every node is encoded as {@code { "<type>.<subType>": <body> }}. The document
 * root key is {@code metadata.root}.</p>
 *
 * <p>Design principles:</p>
 * <ul>
 *   <li><strong>100% registry-driven</strong> — no hardcoded type or subtype names.
 *       New types contributed by a {@code MetaDataTypeProvider} parse without any
 *       edits here.</li>
 *   <li>Canonical format conventions followed by this reader:
 *       <ol>
 *         <li>Wrapper key is {@code <type>.<subType>} (fused); split on first {@code .}.</li>
 *         <li>Root key is {@code metadata.root}; body has no separate {@code subType} field.</li>
 *         <li>Clear seam: {@link #parseToCanonical(InputStream)} (front-end) +
 *             {@link #buildTree(JsonObject)} (registry-driven builder).</li>
 *         <li>Reserved body keys: {@code name}, {@code package}, {@code extends},
 *             {@code abstract}, {@code overlay}, {@code isArray}, {@code children},
 *             {@code value}. The canonical {@code extends} maps to the {@code super}
 *             slot; {@code abstract} maps to the {@code isAbstract} representation.</li>
 *       </ol>
 *   </li>
 *   <li>Reuses {@link BaseMetaDataParser}'s {@link #parseInlineAttribute},
 *       {@link #createOrOverlayMetaData}, and {@link #convertJsonArrayToCommaDelimited}
 *       unchanged.</li>
 * </ul>
 *
 * <p>This class is intentionally a thin layer over {@link BaseMetaDataParser}.</p>
 */
public class CanonicalJsonParser extends BaseMetaDataParser implements MetaDataFileParser {

    private static final Logger log = LoggerFactory.getLogger(CanonicalJsonParser.class);

    // -----------------------------------------------------------------------
    // Canonical reserved body keys — ONLY these strings are named here.
    // They map to the base-parser constant equivalents where needed.
    // -----------------------------------------------------------------------

    /** Canonical body key: short name of the node. Maps to ATTR_NAME. */
    private static final String KEY_NAME = "name";

    /** Canonical body key: package. Maps to ATTR_PACKAGE. */
    private static final String KEY_PACKAGE = "package";

    /**
     * Canonical body key: supertype reference. In canonical JSON the key is
     * {@code extends}; the base parser stores it as {@code super} (ATTR_SUPER).
     */
    private static final String KEY_EXTENDS = "extends";

    /**
     * Canonical body key: abstract flag. In canonical JSON the key is
     * {@code abstract}; the base parser stores it as {@code isAbstract} (MetaData.ATTR_IS_ABSTRACT).
     */
    private static final String KEY_ABSTRACT = "abstract";

    /** Canonical body key: overlay/merge-into flag. Maps to ATTR_OVERLAY. */
    private static final String KEY_OVERLAY = "overlay";

    /** Canonical body key: isArray flag. Maps to native isArray on MetaField/MetaAttribute. */
    private static final String KEY_IS_ARRAY = "isArray";

    /** Canonical body key: children list. Maps to ATTR_CHILDREN. */
    private static final String KEY_CHILDREN = "children";

    /** Canonical body key: value (for attr child nodes). */
    private static final String KEY_VALUE = "value";

    /** Separator between type and subType in the fused node key. */
    private static final String TYPE_SUBTYPE_SEPARATOR = ".";

    /**
     * Prefix for inline @-attributes ({@code "@"}).
     * Public so that downstream modules (e.g. codegen-base schema writer) can reference
     * the canonical attribute-prefix constant without depending on this parser's internals.
     */
    public static final String JSON_ATTR_PREFIX = "@";

    /** All reserved body keys — keys handled structurally (not as @-attrs). */
    private static final List<String> RESERVED_KEYS = Arrays.asList(
        KEY_NAME, KEY_PACKAGE, KEY_EXTENDS, KEY_ABSTRACT, KEY_OVERLAY,
        KEY_IS_ARRAY, KEY_CHILDREN, KEY_VALUE
    );

    /**
     * FR-032 (ADR-0032) — the bare (sigil-free) inline attribute names whose VALUE is a
     * metadata reference. In canonical JSON these are {@code @}-prefixed ({@code @objectRef}, …).
     * Mirrors {@code YamlDesugar.REF_BEARING_ATTR_NAMES} and the TS {@code REF_BEARING_ATTR_NAMES}.
     * The structural {@code extends} key is a reference too, but is guarded separately (it is the
     * bare {@link #KEY_EXTENDS} body key, not an {@code @}-prefixed attr).
     */
    private static final Set<String> REF_BEARING_ATTR_NAMES = Set.of(
        "objectRef", "references", "from", "of", "via",
        "payloadRef", "responseRef", "parameterRef"
    );

    /** FR-032 — package separator ({@code ::}); a value with this leading prefix is root-absolute-relative. */
    private static final String FR032_PKG_SEPARATOR = com.metaobjects.util.MetaDataUtil.SEP;

    /** FR-032 — parent-relative prefix ({@code ..::}). */
    private static final String FR032_PARENT_PREFIX = ".." + FR032_PKG_SEPARATOR;

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * FR5a / ADR-0009 — JSONPath builder threaded through the tree walk.
     *
     * <p>Push/pop keys + indices as we descend so every constructed MetaData
     * node and every error raised mid-parse can be tagged with a canonical
     * JSONPath string for the offending location.</p>
     */
    private final JsonPath.Builder jsonPathBuilder = new JsonPath.Builder();

    /**
     * FR5b — optional JSONPath → {@link YamlPosition} map, populated by
     * {@link com.metaobjects.loader.parser.yaml.ParserYaml} when the input was YAML.
     * When non-null, {@link #currentSourceEnvelope()} and {@link #tagNodeWithJsonSource(MetaData)}
     * emit a {@link YamlSource} (FR5b finalized 2026-05-27, was {@link JsonSource}
     * with optional {@code yamlPosition} during the per-port rollout). The
     * envelope carries the optional {@link YamlPosition} when the desugar's map
     * has a position for the current JSONPath.
     */
    private Map<String, YamlPosition> yamlPositionsByPath = null;

    /** Creates a {@code CanonicalJsonParser} for the given loader and filename. */
    public CanonicalJsonParser(MetaDataLoader loader, String filename) {
        super(loader, filename);
    }

    // -----------------------------------------------------------------------
    // FR5a — source-envelope helpers
    // -----------------------------------------------------------------------

    /**
     * FR5a / ADR-0009 — Tags a freshly-constructed node with a
     * {@link JsonSource} envelope describing where it came from.
     *
     * <p>Idempotent: if the node already carries a JsonSource (overlay path
     * where the node was loaded from an earlier file), the existing source is
     * preserved — overlay/merge phases own subsequent transitions to
     * {@link com.metaobjects.source.MergedSource}.</p>
     *
     * <p>The filename comes from {@link #getFilename()}; the JSONPath from the
     * builder's current state.</p>
     */
    private void tagNodeWithJsonSource(MetaData node) {
        if (node == null) return;
        // Skip if a JSON / YAML / Merged source is already populated (overlay
        // path); the merge phase owns subsequent transitions. CodeSource.DEFAULT
        // (the constructor default) is overwritten on first parse.
        //
        // FR5c — MergedSource MUST be preserved here. Once a node has been
        // upgraded to MergedSource by the merge-attribution code, a subsequent
        // contributor (third file or later) must not have its source reset
        // back to a single-file JsonSource — the next attributeMerge() pass
        // reads the saved {@code preMergeSource} but a no-op (identical
        // re-declaration) leaves the source untouched, and without this
        // preservation the upgrade would silently revert.
        ErrorSource existing = node.getSource();
        if (existing instanceof JsonSource
            || existing instanceof YamlSource
            || existing instanceof MergedSource) return;
        try {
            node.setSource(buildCurrentSourceEnvelope());
        } catch (IllegalStateException frozen) {
            // Node was frozen between phases — leave existing source intact.
            log.debug("Node source frozen; preserving existing source for [{}]", node);
        }
    }

    /**
     * FR5a / ADR-0009 — Constructs an {@link ErrorSource} envelope at the
     * current JSONPath for use in parse-error envelopes.
     *
     * <p>FR5b finalized 2026-05-27 — when the input was YAML (i.e. the
     * desugar populated {@link #yamlPositionsByPath}), this returns a
     * {@link YamlSource} (format {@code "yaml"}). Otherwise it returns a
     * {@link JsonSource} (format {@code "json"}).</p>
     */
    private ErrorSource currentSourceEnvelope() {
        return buildCurrentSourceEnvelope();
    }

    /**
     * FR5a + FR5b — build the source envelope at the current JSONPath.
     *
     * <p>FR5b finalized 2026-05-27 — emits a {@link YamlSource} (format
     * {@code "yaml"}) when the parser was invoked from
     * {@link com.metaobjects.loader.parser.yaml.ParserYaml} and a position
     * map was supplied; the optional {@link YamlPosition} rides along when
     * the desugar's flattened position map covers the current JSONPath.
     * Otherwise emits a {@link JsonSource}.</p>
     */
    private ErrorSource buildCurrentSourceEnvelope() {
        String path = jsonPathBuilder.toString();
        if (yamlPositionsByPath != null) {
            YamlPosition pos = yamlPositionsByPath.get(path);
            return new YamlSource(List.of(getFilename()), path, pos);
        }
        return new JsonSource(List.of(getFilename()), path);
    }

    /**
     * FR-032 (ADR-0032) — guard a ref-bearing value against relative forms.
     *
     * <p>Canonical JSON is the self-contained interchange form: every ref-bearing
     * attribute MUST be fully qualified. A relative authoring form (leading
     * {@code ::} or {@code ..::}) surviving into canonical JSON is
     * {@code ERR_RELATIVE_REF_IN_CANONICAL}. {@link CanonicalJsonParser} only ever
     * handles canonical JSON (it is JSON by construction), so no format check is
     * needed — the YAML desugar expands these forms before the parser sees them.
     * Throwing halts the parse so exactly one error is produced, mirroring the
     * {@code ERR_RESERVED_ATTR} rejection style.</p>
     */
    private void guardRelativeRefInCanonical(String refLabel, String rawValue) {
        if (rawValue == null) return;
        if (!rawValue.startsWith(FR032_PKG_SEPARATOR) && !rawValue.startsWith(FR032_PARENT_PREFIX)) {
            return;
        }
        throw new MetaDataException(
            ErrorMessageConstants.ERR_RELATIVE_REF_IN_CANONICAL
                + ": relative reference '" + rawValue + "' on " + refLabel
                + " in file [" + getFilename() + "] is not allowed in canonical JSON — "
                + "canonical JSON must be fully-qualified. Relative forms (leading '"
                + FR032_PKG_SEPARATOR + "' or '" + FR032_PARENT_PREFIX + "') are "
                + "YAML-authoring sugar that the desugar expands.",
            ErrorCode.ERR_RELATIVE_REF_IN_CANONICAL, currentSourceEnvelope());
    }

    /**
     * FR5a / ADR-0009 — Re-throw a {@link MetaDataException} that escaped a
     * registry/base-parser call site without an envelope, stamping it with the
     * current JSONPath so the cross-port harness sees the offending node's
     * location rather than {@code $}.
     *
     * <p>If the exception already carries an envelope (or it is one of the
     * legacy code-string-in-message exceptions whose code-extraction code
     * never sees the envelope), this method preserves the original. Otherwise
     * it constructs a new {@link MetaDataException} that mirrors the original
     * message + code but adds {@link #currentSourceEnvelope()} as its envelope.</p>
     *
     * <p>Returns the (possibly re-wrapped) exception so the caller can write
     * {@code throw rethrowWithEnvelope(ex);}.</p>
     */
    private MetaDataException rethrowWithEnvelope(MetaDataException ex) {
        if (ex.getEnvelope().isPresent()) return ex;
        // Preserve the original message and structured code (if any) — only the
        // envelope is missing. Cause is the original exception so the stack
        // trace is preserved.
        return new MetaDataException(
            ex.getMessage(),
            null,
            null,
            ex,
            Collections.emptyMap(),
            ex.getCode().orElse(null),
            currentSourceEnvelope());
    }

    /**
     * FR5a / ADR-0009 — Tags an inline-{@code @}-attribute MetaAttribute child
     * (just added via {@link com.metaobjects.loader.parser.BaseMetaDataParser#parseInlineAttribute})
     * with a {@link JsonSource} envelope rooted at the parent body's JSONPath.
     *
     * <p>Inline attributes share their parent body's JSON location because they
     * are body keys (e.g. {@code "@filterable": true}), not separate child node
     * wrappers. We look up the just-added attr by name (own-only) and stamp the
     * current JSONPath onto it.</p>
     *
     * <p>No-op if the attr cannot be found (defensive — the base parser may
     * have swallowed it) or if an attempt to set the source throws because the
     * node is frozen.</p>
     *
     * @param parent the parent node the attr was just added to
     * @param attrName the bare attribute name (no {@code @} prefix)
     */
    private void tagAttrChildWithJsonSource(MetaData parent, String attrName) {
        if (parent == null || attrName == null) return;
        if (!parent.hasMetaAttr(attrName, false)) return;
        try {
            MetaAttribute<?> attr = parent.getMetaAttr(attrName, false);
            if (attr == null) return;
            // Skip if a JSON or YAML source is already populated (overlay / re-emit path).
            if (attr.getSource() instanceof JsonSource ||
                attr.getSource() instanceof YamlSource) return;
            attr.setSource(buildCurrentSourceEnvelope());
        } catch (IllegalStateException frozen) {
            // Node frozen between phases — leave existing source intact.
            log.debug("Attr child source frozen; preserving existing source for [{}.{}]", parent, attrName);
        } catch (MetaDataNotFoundException nf) {
            // Defensive — attr lookup raced; nothing to tag.
            log.debug("Attr child lookup miss for [{}.{}] — skipping source tag", parent, attrName);
        }
    }

    // -----------------------------------------------------------------------
    // MetaDataFileParser / BaseMetaDataParser contract
    // -----------------------------------------------------------------------

    /**
     * Main entry point — parses canonical JSON from the stream into the loader's root.
     *
     * <p>{@code loadFromStream = buildTree(parseToCanonical(is))}.</p>
     */
    @Override
    public void loadFromStream(InputStream is) {
        try {
            buildTree(parseToCanonical(is));
        } catch (MetaDataException e) {
            throw e;
        } catch (RuntimeException e) {
            // Any non-MetaDataException parse-time failure (Gson syntax error or
            // other runtime fault) is reported as malformed JSON so callers see a
            // stable conformance code rather than an untagged exception.
            //
            // FR5a / ADR-0009 — attach a root-of-file JsonSource envelope so the
            // conformance harness sees source.files = [<filename>] and
            // source.jsonPath = "$" (the parse failed before any path could be
            // pushed onto the builder).
            throw new MetaDataException(
                "Error loading canonical JSON from file [" + getFilename() + "]: " + e.getMessage(),
                null, null, e, Collections.emptyMap(),
                ErrorCode.ERR_MALFORMED_JSON,
                new JsonSource(List.of(getFilename()), "$"));
        }
    }

    // -----------------------------------------------------------------------
    // Front-end — UTF-8 read + BOM strip + JSON.parse
    // -----------------------------------------------------------------------

    /**
     * Front-end: reads {@code is} as UTF-8, strips the UTF-8 BOM if present,
     * and parses as JSON, returning the root {@link JsonObject}.
     *
     * <p>Kept independently callable so that tests can directly exercise the
     * JSON parsing without going through {@link #loadFromStream}.</p>
     *
     * @param is input stream (closed by this method)
     * @return the top-level JSON object
     * @throws MetaDataException if the stream cannot be read or the content is not
     *                           a JSON object
     */
    public JsonObject parseToCanonical(InputStream is) {
        try {
            byte[] bytes = is.readAllBytes();
            String content = new String(bytes, StandardCharsets.UTF_8);

            // Strip UTF-8 BOM (0xFEFF) — Java-authored files often include it.
            if (!content.isEmpty() && content.charAt(0) == '﻿') {
                content = content.substring(1);
            }

            JsonElement element = JsonParser.parseString(content);
            if (!element.isJsonObject()) {
                throw new MetaDataException(
                    "Top-level canonical JSON must be an object in file [" + getFilename() + "]");
            }
            return element.getAsJsonObject();

        } catch (IOException e) {
            throw new MetaDataException(
                "Failed to read canonical JSON from file [" + getFilename() + "]: " + e.getMessage(), e);
        } finally {
            try { is.close(); } catch (Exception ignore) {}
        }
    }

    // -----------------------------------------------------------------------
    // Tree builder — registry-driven, independently callable
    // -----------------------------------------------------------------------

    /**
     * Registry-driven builder: walks the canonical JSON object and calls
     * {@link BaseMetaDataParser#createOrOverlayMetaData} for each node.
     *
     * <p>This method is the authoritative tree-building seam. A future YAML
     * front-end can desugar YAML → canonical {@link JsonObject} and then call
     * this method directly — the building logic lives here once.</p>
     *
     * @param canonical the top-level canonical JSON object (already BOM-stripped +
     *                  parsed by {@link #parseToCanonical})
     */
    public void buildTree(JsonObject canonical) {
        buildTree(canonical, null);
    }

    /**
     * FR5b — registry-driven builder overload that accepts a JSONPath →
     * {@link YamlPosition} map produced by
     * {@link com.metaobjects.loader.parser.yaml.ParserYaml} when the input was
     * YAML. The map is consulted from
     * {@link #buildCurrentSourceEnvelope()} so every node's {@link JsonSource} gets
     * stamped with the optional {@code yamlPosition} field.
     *
     * @param canonical       the canonical JSON object (BOM-stripped + parsed)
     * @param positionsByPath FR5b position map (may be {@code null} for JSON input)
     */
    public void buildTree(JsonObject canonical, Map<String, YamlPosition> positionsByPath) {
        this.yamlPositionsByPath = positionsByPath;
        try {
            buildTreeInternal(canonical);
        } finally {
            // Clear so a subsequent buildTree (in pathological re-use) doesn't
            // inherit positions. The Parser is one-shot per file, but defensive.
            this.yamlPositionsByPath = null;
        }
    }

    private void buildTreeInternal(JsonObject canonical) {
        // Find the single wrapper key (skip $schema if present)
        String rootKey = null;
        for (String key : canonical.keySet()) {
            if (!"$schema".equals(key)) {
                if (rootKey != null) {
                    throw new MetaDataException(
                        "Top-level canonical JSON must have exactly one wrapper key in file ["
                            + getFilename() + "]",
                        null, currentSourceEnvelope());
                }
                rootKey = key;
            }
        }
        if (rootKey == null) {
            throw new MetaDataException(
                "Top-level canonical JSON has no wrapper key in file [" + getFilename() + "]",
                null, currentSourceEnvelope());
        }

        // FR5a / ADR-0009 — push the wrapper key as the first JSONPath segment.
        // For the canonical root `metadata.root`, the literal `.` forces bracket-quoted form.
        jsonPathBuilder.pushKey(rootKey);
        try {
            // Split the root key → type + subType
            SplitKey rootSplit = splitTypeKey(rootKey);
            String rootType = rootSplit.type;

            // Validate that the root type is known
            if (!getTypeRegistry().hasType(rootType)) {
                throw new MetaDataException(
                    "Unknown root type '" + rootType + "' in canonical JSON file [" + getFilename() + "]",
                    ErrorCode.ERR_UNKNOWN_TYPE, currentSourceEnvelope());
            }

            JsonElement rootBodyEl = canonical.get(rootKey);
            if (!rootBodyEl.isJsonObject()) {
                throw new MetaDataException(
                    "Root wrapper '" + rootKey + "' must contain an object in file [" + getFilename() + "]",
                    null, currentSourceEnvelope());
            }
            JsonObject rootBody = rootBodyEl.getAsJsonObject();

            // Extract package from the root body and set as the default package for this file.
            // The canonical "package" key sets the default-package context for this file; the
            // loader owns the MetaRoot name and it is not overwritten here.
            String pkgValue = getStringOrNull(rootBody, KEY_PACKAGE);
            if (pkgValue != null) {
                setDefaultPackageName(pkgValue);
            }

            // Process the root body's children into the loader's existing MetaRoot.
            // FR5a — tag the MetaRoot itself with a JsonSource pointing at the wrapper key.
            MetaData loaderRoot = getRootMetaData();
            tagNodeWithJsonSource(loaderRoot);
            processBody(loaderRoot, rootBody);
        } finally {
            jsonPathBuilder.pop();
        }
    }

    // -----------------------------------------------------------------------
    // Node processing — registry-driven, no hardcoded type names
    // -----------------------------------------------------------------------

    /**
     * Processes the document root body: applies any {@code @}-attributes on the root,
     * then recurses into its {@code children} array.
     *
     * <p>This method is only called once, for the top-level {@code metadata.root} body.
     * Children of the root are top-level nodes ({@code isRoot=true}).</p>
     *
     * @param rootNode the loader's MetaRoot node
     * @param body     the canonical JSON body of the {@code metadata.root} wrapper
     */
    private void processBody(MetaData rootNode, JsonObject body) {
        // Process children array if present
        if (body.has(KEY_CHILDREN)) {
            JsonElement childrenEl = body.get(KEY_CHILDREN);
            if (childrenEl.isJsonArray()) {
                // FR5a — push the `children` segment for the recursion.
                jsonPathBuilder.pushKey(KEY_CHILDREN);
                try {
                    processChildrenArray(rootNode, childrenEl.getAsJsonArray(), true);
                } finally {
                    jsonPathBuilder.pop();
                }
            } else {
                log.warn("'children' key is not an array in file [{}]", getFilename());
            }
        }

        // Process @-attributes on the root body (rare but valid).
        processAttributes(rootNode, body);
    }

    /**
     * Iterates a canonical children array and processes each child node.
     *
     * @param parent   the parent MetaData under which children are placed
     * @param children the JSON array of child-node wrapper objects
     * @param isRoot   true when the children are top-level (direct children of
     *                 the document root → placed under {@link #getRootMetaData()})
     */
    private void processChildrenArray(MetaData parent, JsonArray children, boolean isRoot) {
        int idx = 0;
        for (JsonElement childEl : children) {
            // FR5a — push the array index segment for this child.
            jsonPathBuilder.pushIndex(idx);
            try {
                if (!childEl.isJsonObject()) {
                    log.warn("Child element in 'children' array is not an object in file [{}]", getFilename());
                    continue;
                }
                JsonObject childWrapper = childEl.getAsJsonObject();

                // Each child must have exactly one key (the fused type.subType wrapper)
                if (childWrapper.size() != 1) {
                    log.warn("Child node must have exactly one wrapper key (found {}) in file [{}]",
                        childWrapper.size(), getFilename());
                    continue;
                }

                String childKey = childWrapper.keySet().iterator().next();
                JsonElement childBodyEl = childWrapper.get(childKey);

                if (!childBodyEl.isJsonObject()) {
                    log.warn("Child wrapper '{}' must contain an object in file [{}]", childKey, getFilename());
                    continue;
                }
                JsonObject childBody = childBodyEl.getAsJsonObject();

                // Split fused key → type + subType
                SplitKey split = splitTypeKey(childKey);
                String type = split.type;
                String subType = split.subType;

                // FR5a — push the fused wrapper key as a JSONPath segment so the
                // node (and any error raised below) carries the full canonical path.
                jsonPathBuilder.pushKey(childKey);
                try {
                    // Registry check — ADR-0023 strict load: an undeclared child
                    // type/subType is a made-up node. Mirrors the TS reference
                    // (parser-core.ts): a CHILD node (unlike the document root) is
                    // RECORDED (not thrown) and SKIPPED, so a happy-path tree can
                    // still build around it and a multi-error fixture surfaces every
                    // offending node. The code discriminates exactly as TS does:
                    // a known type with an unknown EXPLICIT subType → ERR_UNKNOWN_SUBTYPE;
                    // an entirely unknown type → ERR_UNKNOWN_TYPE. In lax mode the
                    // legacy lenient skip+warn behavior is preserved so a downstream
                    // app can tolerate unenforced types.
                    boolean knownType = getTypeRegistry().hasType(type);
                    boolean knownNode = knownType
                        && getTypeRegistry().getTypeDefinition(type, subType) != null;
                    if (!knownNode) {
                        if (isStrictLoad()) {
                            ErrorCode code = knownType
                                ? ErrorCode.ERR_UNKNOWN_SUBTYPE
                                : ErrorCode.ERR_UNKNOWN_TYPE;
                            getLoader().addError(new MetaDataException(
                                "Unknown type '" + type + "." + subType + "' in canonical JSON file ["
                                    + getFilename() + "] — not declared by any registered provider",
                                code, currentSourceEnvelope()));
                            continue;
                        }
                        log.warn("Unknown type '{}.{}' in canonical JSON file [{}] — skipping",
                            type, subType, getFilename());
                        continue;
                    }

                    // Attr child nodes: { "attr.<subType>": { "name": "...", "value": <v> } }
                    if (MetaAttribute.TYPE_ATTR.equals(type)) {
                        processAttrChildNode(parent, subType, childBody);
                        continue;
                    }

                    processNode(parent, type, subType, childBody, isRoot);
                } finally {
                    jsonPathBuilder.pop();
                }
            } finally {
                jsonPathBuilder.pop();
                idx++;
            }
        }
    }

    /**
     * Processes a single canonical node: extracts reserved keys, calls
     * {@link BaseMetaDataParser#createOrOverlayMetaData}, applies attributes,
     * and recurses into children.
     *
     * <p>Canonical format name defaulting: when no explicit {@code name} key is
     * present in the body, the subType is used as the name. This matches the
     * canonical convention for nodes like {@code identity.primary} where the
     * subType is both the type marker and the identity name. This is registry-driven:
     * any type that omits {@code name} falls back to subType, not hardcoded per-type.</p>
     *
     * @param parent   parent MetaData
     * @param type     the node's type (from the fused key)
     * @param subType  the node's subType (from the fused key)
     * @param body     the node's body JSON object
     * @param isRoot   true when the node is a direct child of the document root
     */
    private void processNode(MetaData parent, String type, String subType,
                             JsonObject body, boolean isRoot) {
        // Extract reserved structural keys
        String name     = getStringOrNull(body, KEY_NAME);
        String pkg      = getStringOrNull(body, KEY_PACKAGE);
        // "extends" (canonical) → "super" (base parser slot)
        String superRef = getStringOrNull(body, KEY_EXTENDS);
        // FR-032 — reject a relative `extends` ref in canonical JSON.
        guardRelativeRefInCanonical("\"" + KEY_EXTENDS + "\"", superRef);
        // "abstract" (canonical) — handled AFTER node creation as an attribute
        Boolean isAbstract = getBooleanOrNull(body, KEY_ABSTRACT);
        Boolean isOverlay  = getBooleanOrNull(body, KEY_OVERLAY);
        Boolean isArray    = getBooleanOrNull(body, KEY_IS_ARRAY);

        // Canonical name defaulting: when no explicit name key, use the subType.
        // This handles identity.primary (no name → name = "primary") and any other
        // type that follows the subType-as-name convention. Registry-driven: no
        // per-type hardcoding.
        //
        // EXCEPTION: types that participate in auto-naming (validator, view, source, identity)
        // skip this fallback. They receive a sequential auto-name from
        // createOrOverlayMetaData (rdb1, rdb2, …) and the serializer's
        // isAutoGeneratedName check suppresses emission of that auto-name on the way
        // out. This preserves byte-parity with the TS oracle, which leaves the name
        // empty and omits the `name` key in canonical output.
        if (name == null || name.isEmpty()) {
            if (!BaseMetaDataParser.isAutoNamingType(type)) {
                name = subType;
            }
        }

        // Create or overlay the MetaData via the format-agnostic base method.
        // Note: we do NOT pass isAbstract to createOrOverlayMetaData — the base
        // method uses it for naming validation only; the actual abstract flag is
        // set via a MetaAttribute below (matching the serializer's isAbstract attribute
        // convention used by CanonicalJsonSerializer).
        //
        // FR5a / ADR-0009 — createOrOverlayMetaData can throw ERR_UNKNOWN_SUBTYPE
        // (and other envelope-less MetaDataExceptions) from the registry layer,
        // which has no JSONPath context. Catch and stamp the current JSONPath
        // here so the cross-port envelope sees the offending node's location
        // rather than $.
        MetaData md;
        try {
            md = createOrOverlayMetaData(
                isRoot,
                parent,
                type,
                subType,
                name,
                pkg,
                superRef,
                /*isAbstract=*/ null,   // set below via attribute
                /*isInterface=*/ null,
                /*implementsArray=*/ null,
                isOverlay
            );
        } catch (MetaDataException ex) {
            throw rethrowWithEnvelope(ex);
        }

        // Remember whether the author explicitly wrote a `"package"` key on
        // this node's body — used by CanonicalJsonSerializer to round-trip a
        // redundantly re-authored package (matches the TS / Python oracles).
        // (isRoot here just means "direct child of metadata.root"; the doc
        // root's own package is tracked separately via setDefaultPackageName.)
        if (pkg != null) {
            md.setPackageAuthored(true);
        }

        // Preserve the raw, as-authored `extends` reference so the canonical
        // serializer can echo it VERBATIM (matching the TS / C# / Python oracles
        // which all re-emit the raw superRef). Without this Java would recompute
        // a short-vs-FQN form and diverge on, e.g., a same-package extends that
        // the author wrote as a full FQN.
        if (md != null && superRef != null && !superRef.isEmpty()) {
            md.setAuthoredSuperRef(superRef);
        }

        if (md == null) {
            log.warn("createOrOverlayMetaData returned null for [{}:{}:{}] in file [{}]",
                type, subType, name, getFilename());
            return;
        }

        // FR5c — capture pre-merge state BEFORE re-tagging the node's source.
        // If the existing source is a JsonSource / YamlSource / MergedSource, a
        // prior file already declared this node and the current file is a
        // contributor to an overlay merge. We snapshot the pre-merge canonical
        // shape (for SemanticDiff) and the pre-merge own-attrs map (for
        // attribute conflict detection) here so the upcoming processAttributes
        // + processChildrenArray walk does not contaminate the baseline.
        ErrorSource preMergeSource = md.getSource();
        boolean isFr5cMergeCandidate = (preMergeSource instanceof JsonSource
            || preMergeSource instanceof YamlSource
            || preMergeSource instanceof MergedSource);
        String preMergeCanonical = null;
        Map<String, String> preMergeAttrSnapshot = null;
        if (isFr5cMergeCandidate) {
            preMergeCanonical = CanonicalJsonSerializer.canonicalSerialize(md);
            preMergeAttrSnapshot = snapshotOwnAttrs(md);
            // Detect attr conflicts up-front. The base-parser's parseInlineAttribute
            // is last-writer-wins (the existing attr child is deleted and replaced),
            // so we must compare BEFORE that replacement happens.
            detectAttrMergeConflicts(md, body, preMergeAttrSnapshot, preMergeSource);
        }

        // FR5a / ADR-0009 — tag the node with its JsonSource provenance.
        tagNodeWithJsonSource(md);

        // Apply abstract flag: canonical "abstract": true → create isAbstract=true MetaAttribute.
        // This mirrors how CanonicalJsonSerializer reads it back (via getIsAbstractValue which
        // looks for an "isAbstract" MetaAttribute with value Boolean.TRUE).
        if (Boolean.TRUE.equals(isAbstract)) {
            super.parseInlineAttribute(md, MetaData.ATTR_IS_ABSTRACT, "true");
            // FR5a / ADR-0009 — tag the synthesized @isAbstract attr child with its
            // JsonSource provenance (parent JSONPath, since `abstract` is a bare key
            // on the body, not an @-attribute key in the JSON).
            tagAttrChildWithJsonSource(md, MetaData.ATTR_IS_ABSTRACT);
        }

        // Apply isArray native property if specified
        if (Boolean.TRUE.equals(isArray)) {
            super.handleNativeIsArrayProperty(md, "true");
        }

        // Apply @-attributes — wrap so envelope-less attribute-value errors
        // (e.g. ERR_BAD_ATTR_VALUE from a bad inline value like
        // @pageSize: "twenty-five") get stamped with the parent node's JSONPath.
        try {
            processAttributes(md, body);
        } catch (MetaDataException ex) {
            throw rethrowWithEnvelope(ex);
        }

        // Recurse into children
        if (body.has(KEY_CHILDREN)) {
            JsonElement childrenEl = body.get(KEY_CHILDREN);
            if (childrenEl.isJsonArray()) {
                // FR5a — push the `children` segment for the recursion.
                jsonPathBuilder.pushKey(KEY_CHILDREN);
                try {
                    processChildrenArray(md, childrenEl.getAsJsonArray(), false);
                } finally {
                    jsonPathBuilder.pop();
                }
            }
        }

        // FR5c — overlay-merge attribution. When a prior file already declared
        // this node (isFr5cMergeCandidate), compare pre/post canonical via
        // SemanticDiff: either upgrade the node's source to MergedSource (real
        // semantic overlay) or emit WARN_DUPLICATE_DECLARATION (identical
        // re-declaration). The decision mirrors the TS reference's behaviour
        // (parser-core.ts parseNodeInto FR5c block).
        if (isFr5cMergeCandidate) {
            attributeMerge(md, preMergeSource, preMergeCanonical);
        }

        // Note: per-type content validation (e.g. field.enum @values) now runs in
        // ValidationPhase.run() after all sources are fully loaded — not here.
        // The parser builds the tree; ValidationPhase validates it post-load.
    }

    /**
     * FR5c — snapshot a node's own (non-inherited) inline-attribute values
     * keyed by attribute name. The snapshot is taken BEFORE the new
     * contribution's attrs land so we can detect cross-file conflicts (same
     * attr, different non-empty values).
     *
     * <p>Values are captured as the attribute's {@code getValueAsString()} —
     * the same canonical form used when serializing back out. {@code null}
     * values are omitted (the conflict-detection rule excludes empty/unset).</p>
     */
    private static Map<String, String> snapshotOwnAttrs(MetaData node) {
        Map<String, String> snapshot = new HashMap<>();
        for (MetaAttribute<?> attr : node.getMetaAttrs(false)) {
            String value = attr.getValueAsString();
            if (value != null) {
                snapshot.put(attr.getName(), value);
            }
        }
        return snapshot;
    }

    /**
     * FR5c — detect attribute-level merge conflicts: for every {@code @attr}
     * key in {@code body}, if {@code preAttrs} already has the same attr with
     * a different non-empty value, accumulate an {@code ERR_MERGE_CONFLICT}
     * (envelope {@code format: "merged"}) on the loader's per-load errors
     * channel.
     *
     * <p>Last-writer-wins remains the merge default for non-conflicting cases
     * (one side unset, same value); the parser proceeds to overwrite via the
     * existing {@link MetaData#addChild(MetaData)} delete-and-replace path
     * after this call. The error surfaces the divergence so a consumer can
     * fix it.</p>
     *
     * <p>The mismatched value comparison is registry-relaxed for booleans
     * (Java boolean attrs serialize as {@code "true"/"false"}; the new value
     * comes from the JSON as the same form via {@code jsonElementToString}),
     * so a string-vs-typed compare is sufficient here.</p>
     */
    private void detectAttrMergeConflicts(MetaData target, JsonObject body,
                                           Map<String, String> preAttrs,
                                           ErrorSource preMergeSource) {
        if (preAttrs.isEmpty()) return;
        List<String> existingFiles = filesOf(preMergeSource);
        String currentFile = getFilename();

        for (Map.Entry<String, JsonElement> entry : body.entrySet()) {
            String key = entry.getKey();
            if (!key.startsWith(JSON_ATTR_PREFIX)) continue;
            if (RESERVED_KEYS.contains(key)) continue;
            String attrName = key.substring(JSON_ATTR_PREFIX.length());
            if (RESERVED_KEYS.contains(attrName)) continue;

            String existingVal = preAttrs.get(attrName);
            if (existingVal == null) continue;
            if (isEmptyJsonValue(entry.getValue())) continue;
            if (existingVal.isEmpty()) continue;

            // Normalize the new JSON value to the same comma-delimited form
            // that {@link MetaAttribute#getValueAsString()} returns for arrays,
            // so a JSON array (e.g. {@code ["a","b"]}) compares equal to the
            // stored {@code "a,b"} representation. This matches the base
            // parser's {@code convertJsonArrayToCommaDelimited} treatment of
            // array-shaped inline attrs.
            String newVal = normalizeAttrValueForCompare(entry.getValue());
            if (newVal == null || newVal.isEmpty()) continue;
            if (existingVal.equals(newVal)) continue;

            // Real conflict — emit ERR_MERGE_CONFLICT with merged envelope.
            List<String> allFiles = unionFilesAlphabetical(existingFiles, currentFile);
            List<Contributor> contributors = buildContributors(allFiles);

            String jsonPath = jsonPathBuilder.toString() + "." + JSON_ATTR_PREFIX + attrName;
            MergedSource envelope = new MergedSource(allFiles, jsonPath, contributors);
            String message = "attr '" + JSON_ATTR_PREFIX + attrName + "' conflicts: existing value "
                + jsonQuote(existingVal) + " differs from new value " + jsonQuote(newVal)
                + " on " + target.getShortName();
            getLoader().addError(new MetaDataException(message, ErrorCode.ERR_MERGE_CONFLICT, envelope));
        }
    }

    /**
     * FR5c — post-process merge attribution. Compares pre/post canonical
     * serialisations of {@code md} (excluding the {@code source} field — see
     * {@link SemanticDiff}) and either upgrades the node's source to
     * {@link MergedSource} (real semantic overlay) or emits
     * {@code WARN_DUPLICATE_DECLARATION} (identical re-declaration).
     *
     * <p>The new contributor file is {@link #getFilename()}; the pre-merge
     * file list comes from {@code preMergeSource.files()}. Both lists are
     * unioned alphabetically per the cross-port load-order contract.</p>
     */
    private void attributeMerge(MetaData md, ErrorSource preMergeSource, String preMergeCanonical) {
        String postMergeCanonical = CanonicalJsonSerializer.canonicalSerialize(md);
        boolean changed;
        if (preMergeCanonical.equals(postMergeCanonical)) {
            changed = false;
        } else {
            JsonElement preEl = JsonParser.parseString(preMergeCanonical);
            JsonElement postEl = JsonParser.parseString(postMergeCanonical);
            changed = SemanticDiff.diff(preEl, postEl);
        }

        List<String> existingFiles = filesOf(preMergeSource);
        String currentFile = getFilename();
        boolean newContributor = !existingFiles.contains(currentFile);

        if (changed) {
            // Real overlay — upgrade source to merged with contributors.
            List<String> allFiles = unionFilesAlphabetical(existingFiles, currentFile);
            String jsonPath = jsonPathOf(preMergeSource);
            try {
                md.setSource(new MergedSource(allFiles, jsonPath, buildContributors(allFiles)));
            } catch (IllegalStateException frozen) {
                log.debug("Node source frozen; cannot upgrade to MergedSource for [{}]", md);
            }
        } else if (newContributor && !existingFiles.isEmpty()) {
            // Identical re-declaration from a different file → warn.
            List<String> allFiles = unionFilesAlphabetical(existingFiles, currentFile);
            String jsonPath = jsonPathOf(preMergeSource);
            MergedSource warnSource = new MergedSource(allFiles, jsonPath, buildContributors(allFiles));
            String message = "duplicate declaration of " + md.getShortName()
                + " with no semantic change";
            getLoader().addEnvelopeWarning(
                new LoaderWarning("WARN_DUPLICATE_DECLARATION", message, warnSource));
        }
    }

    /** FR5c — extract the {@code files} list from an envelope (variant-by-variant). */
    private static List<String> filesOf(ErrorSource src) {
        if (src instanceof JsonSource js) return js.files();
        if (src instanceof YamlSource ys) return ys.files();
        if (src instanceof MergedSource ms) return ms.files();
        return Collections.emptyList();
    }

    /** FR5c — extract the {@code jsonPath} from an envelope (variant-by-variant). */
    private static String jsonPathOf(ErrorSource src) {
        if (src instanceof JsonSource js) return js.jsonPath();
        if (src instanceof YamlSource ys) return ys.jsonPath();
        if (src instanceof MergedSource ms) return ms.jsonPath();
        return "$";
    }

    /**
     * FR5c — union an existing file list with a new contributor file and
     * return the alphabetically-sorted, de-duplicated result. The
     * alphabetical order is the cross-port load-order contract; the dedup
     * handles the case where the new contributor was already present (e.g.
     * a fixture's {@code DirectorySource} re-yields the same file id).
     */
    private static List<String> unionFilesAlphabetical(List<String> existing, String newFile) {
        Set<String> deduped = new LinkedHashSet<>(existing);
        deduped.add(newFile);
        return new ArrayList<>(new TreeSet<>(deduped));
    }

    /**
     * FR5c — build a {@link Contributor} list for an alphabetised file list.
     * Position 0 is {@code overlay-base}; all subsequent positions are
     * {@code overlay-extension}. Matches the cross-port role taxonomy in
     * {@link Contributor}.
     */
    private static List<Contributor> buildContributors(List<String> files) {
        List<Contributor> out = new ArrayList<>(files.size());
        for (int i = 0; i < files.size(); i++) {
            out.add(new Contributor(files.get(i), i == 0 ? "overlay-base" : "overlay-extension"));
        }
        return out;
    }

    /**
     * FR5c — normalize a raw JSON inline-attr value into the same form
     * {@link MetaAttribute#getValueAsString()} returns when round-tripped
     * through the base parser. JSON arrays {@code [...]} are converted to
     * comma-delimited form so {@code ["a","b"]} compares equal to a stored
     * {@code "a,b"} — matching the base parser's array desugar.
     */
    private String normalizeAttrValueForCompare(JsonElement el) {
        String raw = jsonElementToString(el);
        if (raw == null) return null;
        String trimmed = raw.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            return convertJsonArrayToCommaDelimited(trimmed);
        }
        return raw;
    }

    /** FR5c — empty-value check matching the TS reference. */
    private static boolean isEmptyJsonValue(JsonElement el) {
        if (el == null || el.isJsonNull()) return true;
        if (el.isJsonArray() && el.getAsJsonArray().size() == 0) return true;
        if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isString()
            && el.getAsString().isEmpty()) return true;
        return false;
    }

    /** Quote a string for embedding in error messages (matches TS JSON.stringify behaviour). */
    private static String jsonQuote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default: sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    /**
     * Handles a typed {@code attr} child node in the canonical format:
     * {@code { "attr.<subType>": { "name": "...", "value": <v> } }}.
     *
     * <p>Mirrors {@code parser-core.ts:parseAttrChild}: reads {@code name} (required,
     * non-empty) and {@code value} (required), then <strong>honours the declared
     * {@code subType}</strong> from the fused key. Specifically:</p>
     * <ol>
     *   <li>Resolves the subtype: if {@code (MetaAttribute.TYPE_ATTR, subType)} is
     *       registered in the type registry, {@code subType} is used; otherwise falls
     *       back to {@link MetaData#SUBTYPE_BASE}. This mirrors the TS
     *       {@code parseAttrChild} fallback logic.</li>
     *   <li>Creates the attribute instance via
     *       {@code getTypeRegistry().createInstance(TYPE_ATTR, resolvedSubType, attrName)}
     *       — yielding the correctly-typed subclass ({@code StringAttribute},
     *       {@code IntAttribute}, etc.) for the declared type, not the inferred one.</li>
     *   <li>Sets the value via {@link MetaAttribute#setValueAsString}, letting the
     *       declared type drive conversion (e.g. {@code "64"} stays a string when
     *       {@code attr.string} was declared).</li>
     *   <li>For JSON-array values ({@code [...]}) the array is converted to
     *       comma-delimited form and {@link MetaAttribute#setArray(boolean)} is set,
     *       consistent with how {@code parseInlineAttribute} treats {@code @}-array
     *       attributes.</li>
     * </ol>
     *
     * <p>This is 100% registry-driven — {@link MetaAttribute#TYPE_ATTR} is the only
     * framework constant; no hardcoded subtype literals appear in this method.</p>
     *
     * @param parent   the parent MetaData node on which the attribute should be created
     * @param subType  the attribute subtype from the fused key (e.g. {@code "string"}, {@code "int"})
     * @param body     the child body containing {@code name} and {@code value}
     * @throws MetaDataException if {@code name} is missing/empty or {@code value} is absent
     */
    private void processAttrChildNode(MetaData parent, String subType, JsonObject body) {
        String attrName = getStringOrNull(body, KEY_NAME);
        if (attrName == null || attrName.isEmpty()) {
            throw new MetaDataException(
                "attr child node requires a non-empty '" + KEY_NAME + "' in file [" + getFilename() + "]");
        }
        if (!body.has(KEY_VALUE)) {
            throw new MetaDataException(
                "attr child '" + attrName + "' is missing '" + KEY_VALUE + "' in file [" + getFilename() + "]");
        }

        JsonElement valueEl = body.get(KEY_VALUE);

        // Step 1: Resolve the subtype — honour the declared subType from the fused key.
        // If (TYPE_ATTR, subType) is registered, use it; otherwise fall back to SUBTYPE_BASE
        // (the polymorphic/unconstrained marker). This mirrors parseAttrChild in parser-core.ts.
        String resolvedSubType = getTypeRegistry().isRegistered(MetaAttribute.TYPE_ATTR, subType)
            ? subType
            : MetaData.SUBTYPE_BASE;

        // Step 2: Create the correctly-typed attribute instance via the registry.
        // This yields StringAttribute for "string", IntAttribute for "int", etc. —
        // the declared type drives the class, not value-based inference.
        MetaAttribute<?> attr = (MetaAttribute<?>) getTypeRegistry().createInstance(
            MetaAttribute.TYPE_ATTR, resolvedSubType, attrName);

        if (attr == null) {
            throw new MetaDataException(
                "Registry could not create attr [" + MetaAttribute.TYPE_ATTR + ":" + resolvedSubType
                    + "] named '" + attrName + "' in file [" + getFilename() + "]");
        }

        // Step 3: Convert the JSON value to a string form and set it on the attribute.
        // For JSON-array values, convert to comma-delimited format and mark isArray=true,
        // consistent with how parseInlineAttribute handles @-array attributes.
        String stringValue = jsonElementToString(valueEl);
        boolean isJsonArray = false;
        if (stringValue != null && stringValue.trim().startsWith("[") && stringValue.trim().endsWith("]")) {
            stringValue = convertJsonArrayToCommaDelimited(stringValue);
            isJsonArray = true;
        }
        attr.setValueAsString(stringValue);
        if (isJsonArray) {
            attr.setArray(true);
        }

        // FR5a / ADR-0009 — tag the attr with its JsonSource provenance.
        tagNodeWithJsonSource(attr);

        // Step 4: Attach the attribute to the parent.
        parent.addChild(attr);
    }

    /**
     * Processes all @-prefixed attribute keys in the body, delegating each to
     * {@link BaseMetaDataParser#parseInlineAttribute(MetaData, String, String)}.
     *
     * <p>Reserved structural keys (name, package, extends, abstract, overlay,
     * isArray, children, value) are skipped here — they are handled before this call.</p>
     *
     * <p>The canonical format mandates {@code @} prefixes on all attributes;
     * non-prefixed, non-reserved keys are skipped with a warning.</p>
     *
     * <p>Canonical bare-string desugar: if a non-array JSON value (a string primitive)
     * is authored for an attribute that the registry declares as an array (e.g.
     * {@code identity.primary.fields.array} constraint exists), the bare string is
     * wrapped as a single-element JSON array {@code ["value"]} before being passed
     * to the base parser. This mirrors the TypeScript parser's
     * {@code normalizeStringArrayAttr} behavior. The check is registry-driven via
     * {@link com.metaobjects.registry.MetaDataRegistry#hasConstraint(String)} —
     * no hardcoded attr names.</p>
     *
     * @param md   the MetaData node to add attributes to
     * @param body the node's body JSON object
     */
    private void processAttributes(MetaData md, JsonObject body) {
        for (Map.Entry<String, JsonElement> entry : body.entrySet()) {
            String key = entry.getKey();

            // Skip all reserved structural keys
            if (RESERVED_KEYS.contains(key)) {
                continue;
            }

            if (!key.startsWith(JSON_ATTR_PREFIX)) {
                // Non-reserved, non-@-prefixed key — warn and skip
                log.warn("Unknown key '{}' on node [{}:{}:{}] in file [{}] — " +
                    "must be reserved or @-prefixed",
                    key, md.getType(), md.getSubType(), md.getName(), getFilename());
                continue;
            }

            // Strip the @ prefix
            String attrName = key.substring(JSON_ATTR_PREFIX.length());

            // FR-032 (ADR-0032) — reject a relative reference value on a ref-bearing
            // inline attr (@objectRef / @references / @from / @of / @via / @payloadRef /
            // @responseRef / @parameterRef). Canonical JSON must be fully-qualified.
            if (REF_BEARING_ATTR_NAMES.contains(attrName)) {
                JsonElement refVal = entry.getValue();
                if (refVal.isJsonPrimitive() && refVal.getAsJsonPrimitive().isString()) {
                    guardRelativeRefInCanonical(key, refVal.getAsString());
                }
            }

            // ADR-0006 §D1: reserved structural keywords must be written bare in canonical JSON.
            // Writing them as @-prefixed attributes (e.g. @isArray, @name) is unconditionally
            // invalid — there is no registry-exception.
            if (RESERVED_KEYS.contains(attrName)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_RESERVED_ATTR
                        + ": reserved structural key '" + attrName + "' must not be "
                        + JSON_ATTR_PREFIX + "-prefixed on " + md.getType() + "." + md.getSubType()
                        + " '" + md.getName() + "' in file [" + getFilename() + "] — write it bare",
                    ErrorCode.ERR_RESERVED_ATTR, currentSourceEnvelope());
            }

            // ADR-0023 strict load: an own @-attr declared by NO registered
            // provider (no per-type schema entry, no commonAttr) is a made-up
            // attribute → ERR_UNKNOWN_ATTR. Closes the open-attr policy. Mirrors
            // the TS reference: the error is RECORDED (not thrown) and parsing
            // CONTINUES — the attr is still materialized so a happy-path tree
            // serializes byte-identically (the open-policy tree shape is
            // preserved; strict only ADDS the diagnostic). In lax mode this is a
            // no-op so a downstream app can carry unenforced attributes silently.
            //
            // ADR-0023 attr.properties exemption: an undeclared @-attr whose value
            // is a plain JSON object materializes to the sanctioned attr.properties
            // subtype (an arbitrary-named property bag whose name IS the contract),
            // so it is NOT a made-up attribute. See {@link #isExemptPropertiesAttr}.
            if (isStrictLoad()
                    && !isDeclaredAttribute(md, attrName)
                    && !isExemptPropertiesAttr(entry.getValue())) {
                getLoader().addError(new MetaDataException(
                    "Unknown attribute '" + JSON_ATTR_PREFIX + attrName + "' on "
                        + md.getType() + "." + md.getSubType() + " '" + md.getName()
                        + "' in file [" + getFilename() + "] — not declared by any "
                        + "registered provider for " + md.getType() + "." + md.getSubType(),
                    ErrorCode.ERR_UNKNOWN_ATTR, currentSourceEnvelope()));
            }

            // Canonical bare-string → JSON-array desugar for array-declared attributes.
            // If the raw JSON value is a string primitive (not already a JSON array) AND
            // the registry has an array constraint for this attribute (constraint ID:
            // "<type>.<subType>.<attrName>.array" — or, for cross-language commonAttrs,
            // the wildcard "*.*.<attrName>.array"), wrap the bare string as ["value"].
            // This lets the base parser's existing [...]  → comma-delimited → isArray=true
            // path fire correctly, without any hardcoded attribute names.
            JsonElement rawValue = entry.getValue();
            // Cross-port: object-valued attrs (e.g. attr.filter) MUST be authored as
            // a JSON object. The legacy form `@filter: "..."` (string-quoted JSON) is
            // rejected here so the loader surfaces ERR_BAD_ATTR_VALUE before the
            // attribute's setValueAsString silently re-parses the string.
            if (rawValue.isJsonPrimitive() && rawValue.getAsJsonPrimitive().isString()) {
                com.metaobjects.registry.TypeDefinition parentDef =
                    getTypeRegistry().getTypeDefinition(md.getType(), md.getSubType());
                if (parentDef != null) {
                    com.metaobjects.registry.ChildRequirement req = parentDef.getChildRequirement(attrName);
                    if (req != null
                            && MetaAttribute.TYPE_ATTR.equals(req.getExpectedType())
                            && com.metaobjects.attr.FilterAttribute.SUBTYPE_FILTER.equals(req.getExpectedSubType())) {
                        throw new MetaDataException(
                            ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                                + ": @" + attrName + " on " + md.getType() + "." + md.getSubType()
                                + " '" + md.getName() + "' must be a JSON object, not a string"
                                + " (legacy string-quoted filter form is rejected) in file [" + getFilename() + "]",
                            ErrorCode.ERR_BAD_ATTR_VALUE, currentSourceEnvelope());
                    }
                }
            }
            String stringValue;
            if (rawValue.isJsonPrimitive() && rawValue.getAsJsonPrimitive().isString()) {
                String arrayConstraintId = md.getType() + "." + md.getSubType() + "." + attrName + ".array";
                String commonArrayConstraintId = "*.*." + attrName + ".array";
                if (getTypeRegistry().hasConstraint(arrayConstraintId)
                        || getTypeRegistry().hasConstraint(commonArrayConstraintId)) {
                    // Desugar: wrap bare string as single-element JSON array
                    stringValue = "[\"" + rawValue.getAsString().replace("\\", "\\\\").replace("\"", "\\\"") + "\"]";
                    log.debug("Desugared bare string @{} to JSON array for [{}:{}] in file [{}]",
                        attrName, md.getType(), md.getSubType(), getFilename());
                } else {
                    stringValue = jsonElementToString(rawValue);
                }
            } else {
                stringValue = jsonElementToString(rawValue);
            }

            // Delegate to the base parser — handles type inference + array desugar
            super.parseInlineAttribute(md, attrName, stringValue);

            // FR5a / ADR-0009 — tag the just-added inline attr child with its
            // JsonSource provenance. The base parser adds the MetaAttribute as a
            // child of `md`; we look it up by attrName (own-only) and stamp the
            // current JSONPath (the parent body's path — inline attrs share the
            // body's JSON location since they are body keys, not separate nodes).
            tagAttrChildWithJsonSource(md, attrName);
        }
    }

    // -----------------------------------------------------------------------
    // splitTypeKey — mirrors parser-core.ts:splitTypeKey
    // -----------------------------------------------------------------------

    /**
     * Splits a fused {@code <type>.<subType>} key on the FIRST {@code .}.
     *
     * <p>Rules (mirrors TypeScript {@code parser-core.ts:splitTypeKey}):</p>
     * <ul>
     *   <li>A key with no {@code .} → subType is the registry default (base subtype).</li>
     *   <li>A key with a {@code .} → text before is type; text after is subType.</li>
     * </ul>
     *
     * @param key the fused type key, e.g. {@code "object.entity"}, {@code "metadata.root"}
     * @return a {@link SplitKey} with the resolved type and subType
     */
    private SplitKey splitTypeKey(String key) {
        int dotIdx = key.indexOf(TYPE_SUBTYPE_SEPARATOR);
        if (dotIdx < 0) {
            // Bare key with no dot — subType is the registry default
            // Fall back to "base" (MetaData.SUBTYPE_BASE) which all type hierarchies register.
            return new SplitKey(key, MetaData.SUBTYPE_BASE);
        }
        String type    = key.substring(0, dotIdx);
        String subType = key.substring(dotIdx + TYPE_SUBTYPE_SEPARATOR.length());
        return new SplitKey(type, subType);
    }

    /** Simple pair holder for a type/subType split result. */
    private static final class SplitKey {
        final String type;
        final String subType;

        SplitKey(String type, String subType) {
            this.type    = type;
            this.subType = subType;
        }
    }

    // -----------------------------------------------------------------------
    // JSON value utilities
    // -----------------------------------------------------------------------

    /**
     * Returns the string value of a key in the body object, or {@code null} if
     * the key is absent or its value is JSON null.
     */
    private static String getStringOrNull(JsonObject body, String key) {
        if (!body.has(key)) return null;
        JsonElement el = body.get(key);
        if (el.isJsonNull()) return null;
        return el.getAsString();
    }

    /**
     * Returns the boolean value of a key in the body object, or {@code null} if
     * the key is absent or its value is JSON null.
     *
     * <p>Throws a {@link MetaDataException} if the key is present but its JSON value
     * is not a real JSON boolean ({@code true} / {@code false}). Gson's
     * {@code getAsBoolean()} silently coerces strings ({@code "yes"} → {@code false}),
     * which would cause structural flags like {@code abstract} and {@code isArray} to
     * be silently mis-parsed as {@code false}.</p>
     *
     * @param body the JSON object to read from
     * @param key  the key to look up (e.g. {@code "abstract"}, {@code "isArray"})
     * @return the boolean value, or {@code null} if absent / JSON null
     * @throws MetaDataException if the value is present but not a JSON boolean
     */
    private Boolean getBooleanOrNull(JsonObject body, String key) {
        if (!body.has(key)) return null;
        JsonElement el = body.get(key);
        if (el.isJsonNull()) return null;
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isBoolean()) {
            throw new MetaDataException(
                "Key '" + key + "' must be a JSON boolean (true/false) but got: "
                    + el + " in file [" + getFilename() + "]");
        }
        return el.getAsBoolean();
    }

    /**
     * Converts a {@link JsonElement} to a string representation suitable for
     * {@link BaseMetaDataParser#parseInlineAttribute}.
     *
     * <p>JSON arrays are preserved in their {@code [...]}-form so that the base
     * parser's {@link #convertJsonArrayToCommaDelimited} logic fires correctly.</p>
     */
    private static String jsonElementToString(JsonElement el) {
        if (el.isJsonNull()) {
            return null;
        }
        if (el.isJsonPrimitive()) {
            if (el.getAsJsonPrimitive().isBoolean()) {
                return String.valueOf(el.getAsBoolean());
            }
            // String or number — use getAsString() to get the raw value without quotes
            return el.getAsString();
        }
        if (el.isJsonArray()) {
            // Preserve JSON array format — the base parser detects [...]
            return el.toString();
        }
        // Fallback for nested objects (unusual for attr values)
        return el.toString();
    }

    // -----------------------------------------------------------------------
    // MetaDataFileParser overrides
    // -----------------------------------------------------------------------

    @Override
    public MetaDataLoader getLoader() {
        return loader;
    }

    // -----------------------------------------------------------------------
    // ADR-0023 — strict-load helpers
    // -----------------------------------------------------------------------

    /**
     * ADR-0023 strict load: returns the loader's strict flag. Under strict the
     * loader rejects any authored type/subType/attribute not declared by a
     * registered provider; a downstream app may set {@code strict=false} to
     * tolerate unenforced vocabulary. The library + conformance runner load
     * strict (see {@link LoaderOptions#isStrict()}).
     */
    private boolean isStrictLoad() {
        return getLoader().getLoaderOptions().isStrict();
    }

    /**
     * ADR-0023 strict load: is {@code attrName} a declared attribute for this
     * node? Mirrors the TS reference "Check 0" effective-schema lookup — an own
     * {@code @}-attr counts as declared iff it matches EITHER an explicit per-type
     * child attribute requirement (named, direct or inherited) OR a registered
     * cross-language common attribute. Anything else is a made-up attribute →
     * {@link ErrorCode#ERR_UNKNOWN_ATTR}.
     *
     * <p>Registry-driven (no hardcoded attribute names). A parent's catch-all
     * {@code attr,*} wildcard is the LAX open-attr policy and is NOT honored here:
     * under strict an attribute must be explicitly declared (matching TS), so the
     * wildcard does not bless arbitrary names.</p>
     */
    private boolean isDeclaredAttribute(MetaData md, String attrName) {
        com.metaobjects.registry.TypeDefinition typeDef =
            getTypeRegistry().getTypeDefinition(md.getType(), md.getSubType());
        if (typeDef == null) {
            // No type definition to validate against — fall back to permissive
            // (the node itself would already have failed an unknown-subtype check).
            return true;
        }

        // 1) Named per-type attribute requirement (direct or inherited).
        com.metaobjects.registry.ChildRequirement named = typeDef.getChildRequirement(attrName);
        if (named != null && MetaAttribute.TYPE_ATTR.equals(named.getExpectedType())) {
            return true;
        }

        // 2) Cross-language common attribute (valid on any node).
        if (getTypeRegistry().getCommonAttribute(attrName) != null) {
            return true;
        }

        // NOTE (ADR-0023): a parent's catch-all {@code attr,*} wildcard child
        // requirement is the LAX open-attr policy and is deliberately NOT honored
        // here — under strict load an attribute counts as declared only when it
        // has an explicit per-type schema entry or is a registered common attr
        // (matching the TS reference's effective-schema "Check 0"). The wildcard
        // still governs lax loads via the normal placement path. (The
        // attr.properties exemption is applied at the call site, keyed on the
        // attr VALUE shape — see {@link #isExemptPropertiesAttr}.)
        return false;
    }

    /**
     * ADR-0023 attr.properties exemption (mirrors the TS reference's strict
     * Check-0 + {@code inferUndeclaredAttrSubType}). An undeclared inline
     * {@code @}-attr whose JSON value is a plain object materializes to the
     * sanctioned {@code attr.properties} subtype — a registered, canonical attr
     * subtype whose designed purpose is an arbitrary-named structural property
     * bag (the bag's NAME is intentionally not declared by any per-type schema;
     * the name IS the contract). It is sanctioned vocabulary, not a made-up
     * attribute, so it is exempt from {@link ErrorCode#ERR_UNKNOWN_ATTR}.
     *
     * <p>Keyed on the VALUE shape, exactly as the TS reference keys on the
     * materialized subType (object value → {@code ATTR_SUBTYPE_PROPERTIES}):
     * a typo'd plain scalar/array {@code @}-attr does NOT resolve to properties
     * and still records the error. A JSON array is the {@code stringarray}
     * coercion axis, NOT a property bag, so it is not exempt.</p>
     */
    private boolean isExemptPropertiesAttr(JsonElement rawValue) {
        return rawValue != null && rawValue.isJsonObject();
    }
}
