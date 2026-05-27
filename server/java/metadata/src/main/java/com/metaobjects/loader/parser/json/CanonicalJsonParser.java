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
import com.metaobjects.source.ErrorSource;
import com.metaobjects.source.JsonPath;
import com.metaobjects.source.JsonSource;
import com.metaobjects.util.ErrorMessageConstants;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.BaseMetaDataParser;
import com.metaobjects.loader.parser.MetaDataFileParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

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
 *             slot; {@code abstract} maps to the {@code _isAbstract} representation.</li>
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
     * {@code abstract}; the base parser stores it as {@code _isAbstract} (ATTR_ISABSTRACT).
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
        // Skip if a JsonSource is already populated (overlay path); the merge phase
        // owns transitions to MergedSource. CodeSource.DEFAULT (the constructor
        // default) is overwritten on first parse.
        ErrorSource existing = node.getSource();
        if (existing instanceof JsonSource) return;
        try {
            node.setSource(new JsonSource(List.of(getFilename()), jsonPathBuilder.toString()));
        } catch (IllegalStateException frozen) {
            // Node was frozen between phases — leave existing source intact.
            log.debug("Node source frozen; preserving existing source for [{}]", node);
        }
    }

    /**
     * FR5a / ADR-0009 — Constructs a {@link JsonSource} envelope at the
     * current JSONPath for use in parse-error envelopes.
     */
    private JsonSource currentJsonSource() {
        return new JsonSource(List.of(getFilename()), jsonPathBuilder.toString());
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
            // Skip if a JsonSource is already populated (overlay / re-emit path).
            if (attr.getSource() instanceof JsonSource) return;
            attr.setSource(new JsonSource(List.of(getFilename()), jsonPathBuilder.toString()));
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
            throw new MetaDataException(
                "Error loading canonical JSON from file [" + getFilename() + "]: " + e.getMessage(),
                null, null, e, Collections.emptyMap(),
                ErrorCode.ERR_MALFORMED_JSON);
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
        // Find the single wrapper key (skip $schema if present)
        String rootKey = null;
        for (String key : canonical.keySet()) {
            if (!"$schema".equals(key)) {
                if (rootKey != null) {
                    throw new MetaDataException(
                        "Top-level canonical JSON must have exactly one wrapper key in file ["
                            + getFilename() + "]",
                        null, currentJsonSource());
                }
                rootKey = key;
            }
        }
        if (rootKey == null) {
            throw new MetaDataException(
                "Top-level canonical JSON has no wrapper key in file [" + getFilename() + "]",
                null, currentJsonSource());
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
                    ErrorCode.ERR_UNKNOWN_TYPE, currentJsonSource());
            }

            JsonElement rootBodyEl = canonical.get(rootKey);
            if (!rootBodyEl.isJsonObject()) {
                throw new MetaDataException(
                    "Root wrapper '" + rootKey + "' must contain an object in file [" + getFilename() + "]",
                    null, currentJsonSource());
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
                    // Registry check — skip unknown types with a warning
                    if (!getTypeRegistry().hasType(type)) {
                        log.warn("Unknown type '{}' in canonical JSON file [{}] — skipping", type, getFilename());
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
        MetaData md = createOrOverlayMetaData(
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

        if (md == null) {
            log.warn("createOrOverlayMetaData returned null for [{}:{}:{}] in file [{}]",
                type, subType, name, getFilename());
            return;
        }

        // FR5a / ADR-0009 — tag the node with its JsonSource provenance.
        tagNodeWithJsonSource(md);

        // Apply abstract flag: canonical "abstract": true → create _isAbstract=true MetaAttribute.
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

        // Apply @-attributes
        processAttributes(md, body);

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

        // Note: per-type content validation (e.g. field.enum @values) now runs in
        // ValidationPhase.run() after all sources are fully loaded — not here.
        // The parser builds the tree; ValidationPhase validates it post-load.
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

            // ADR-0006 §D1: reserved structural keywords must be written bare in canonical JSON.
            // Writing them as @-prefixed attributes (e.g. @isArray, @name) is unconditionally
            // invalid — there is no registry-exception.
            if (RESERVED_KEYS.contains(attrName)) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_RESERVED_ATTR
                        + ": reserved structural key '" + attrName + "' must not be "
                        + JSON_ATTR_PREFIX + "-prefixed on " + md.getType() + "." + md.getSubType()
                        + " '" + md.getName() + "' in file [" + getFilename() + "] — write it bare",
                    ErrorCode.ERR_RESERVED_ATTR, currentJsonSource());
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
                            ErrorCode.ERR_BAD_ATTR_VALUE, currentJsonSource());
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
}
