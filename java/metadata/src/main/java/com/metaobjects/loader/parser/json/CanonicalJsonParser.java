package com.metaobjects.loader.parser.json;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.BaseMetaDataParser;
import com.metaobjects.loader.parser.MetaDataFileParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
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
 *   <li>Behavioural differences from {@link JsonMetaDataParser} are exactly those
 *       mandated by the canonical format:
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
 * <p>This class is intentionally a thin layer over {@link BaseMetaDataParser}.
 * {@link JsonMetaDataParser} is untouched; production still uses it until a later task.</p>
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

    /** Prefix for inline @-attributes. */
    private static final String ATTR_PREFIX = "@";

    /** All reserved body keys — keys handled structurally (not as @-attrs). */
    private static final List<String> RESERVED_KEYS = Arrays.asList(
        KEY_NAME, KEY_PACKAGE, KEY_EXTENDS, KEY_ABSTRACT, KEY_OVERLAY,
        KEY_IS_ARRAY, KEY_CHILDREN, KEY_VALUE
    );

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /** Creates a {@code CanonicalJsonParser} for the given loader and filename. */
    public CanonicalJsonParser(MetaDataLoader loader, String filename) {
        super(loader, filename);
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
        } catch (Exception e) {
            throw new MetaDataException(
                "Error loading canonical JSON from file [" + getFilename() + "]: " + e.getMessage(), e);
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
                            + getFilename() + "]");
                }
                rootKey = key;
            }
        }
        if (rootKey == null) {
            throw new MetaDataException(
                "Top-level canonical JSON has no wrapper key in file [" + getFilename() + "]");
        }

        // Split the root key → type + subType
        SplitKey rootSplit = splitTypeKey(rootKey);
        String rootType = rootSplit.type;
        String rootSubType = rootSplit.subType;

        // Validate that the root type is known
        if (!getTypeRegistry().hasType(rootType)) {
            throw new MetaDataException(
                "Unknown root type '" + rootType + "' in canonical JSON file [" + getFilename() + "]");
        }

        JsonElement rootBodyEl = canonical.get(rootKey);
        if (!rootBodyEl.isJsonObject()) {
            throw new MetaDataException(
                "Root wrapper '" + rootKey + "' must contain an object in file [" + getFilename() + "]");
        }
        JsonObject rootBody = rootBodyEl.getAsJsonObject();

        // Extract package from the root body and set as the default package for this file
        String pkgValue = getStringOrNull(rootBody, KEY_PACKAGE);
        if (pkgValue != null) {
            setDefaultPackageName(pkgValue);
        }

        // The root node IS the loader's root — we do not create a new MetaRoot.
        // Set the root's name to the package value (mirrors how MetaDataLoader names the root).
        if (pkgValue != null && !pkgValue.isEmpty()) {
            // MetaRoot's full name is the package itself — set via rename if available,
            // or simply record it via the loader's existing root.
            // The loader's root already has a name set at construction time; we honour
            // the canonical package by updating the default package context.
        }

        // Process the root body's children into the loader's existing MetaRoot.
        // Attributes on the root body (rare) are processed first.
        MetaData loaderRoot = getRootMetaData();
        processBody(loaderRoot, rootBody, true);
    }

    // -----------------------------------------------------------------------
    // Node processing — registry-driven, no hardcoded type names
    // -----------------------------------------------------------------------

    /**
     * Processes a node body: extracts reserved keys, creates/overlays the
     * MetaData via {@link BaseMetaDataParser#createOrOverlayMetaData}, applies
     * attributes, then recurses into children.
     *
     * @param parent   the parent MetaData under which this node is placed
     * @param body     the canonical JSON body object for this node
     * @param isRoot   true when processing the document root node's body
     *                 (children go directly into {@link #getRootMetaData()})
     */
    private void processBody(MetaData parent, JsonObject body, boolean isRoot) {
        // Process children array if present
        if (body.has(KEY_CHILDREN)) {
            JsonElement childrenEl = body.get(KEY_CHILDREN);
            if (childrenEl.isJsonArray()) {
                processChildrenArray(parent, childrenEl.getAsJsonArray(), isRoot);
            } else {
                log.warn("'children' key is not an array in file [{}]", getFilename());
            }
        }

        // Process @-attributes on the parent (root-level body attrs).
        // For the loader root these are unusual but valid.
        if (isRoot) {
            processAttributes(parent, body);
        }
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
        for (JsonElement childEl : children) {
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

            // Registry check — skip unknown types with a warning (mirrors JsonMetaDataParser)
            if (!getTypeRegistry().hasType(type)) {
                log.warn("Unknown type '{}' in canonical JSON file [{}] — skipping", type, getFilename());
                continue;
            }

            processNode(parent, type, subType, childBody, isRoot);
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
        if (name == null || name.isEmpty()) {
            name = subType;
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

        // Apply abstract flag: canonical "abstract": true → create _isAbstract=true MetaAttribute.
        // This mirrors how CanonicalJsonSerializer reads it back (via getIsAbstractValue which
        // looks for an "isAbstract" MetaAttribute with value Boolean.TRUE).
        if (Boolean.TRUE.equals(isAbstract)) {
            super.parseInlineAttribute(md, MetaData.ATTR_IS_ABSTRACT, "true");
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
                processChildrenArray(md, childrenEl.getAsJsonArray(), false);
            }
        }
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

            if (!key.startsWith(ATTR_PREFIX)) {
                // Non-reserved, non-@-prefixed key — warn and skip
                log.warn("Unknown key '{}' on node [{}:{}:{}] in file [{}] — " +
                    "must be reserved or @-prefixed",
                    key, md.getType(), md.getSubType(), md.getName(), getFilename());
                continue;
            }

            // Strip the @ prefix
            String attrName = key.substring(ATTR_PREFIX.length());

            // Canonical bare-string → JSON-array desugar for array-declared attributes.
            // If the raw JSON value is a string primitive (not already a JSON array) AND
            // the registry has an array constraint for this attribute (constraint ID:
            // "<type>.<subType>.<attrName>.array"), wrap the bare string as ["value"].
            // This lets the base parser's existing [...]  → comma-delimited → isArray=true
            // path fire correctly, without any hardcoded attribute names.
            JsonElement rawValue = entry.getValue();
            String stringValue;
            if (rawValue.isJsonPrimitive() && rawValue.getAsJsonPrimitive().isString()) {
                String arrayConstraintId = md.getType() + "." + md.getSubType() + "." + attrName + ".array";
                if (getTypeRegistry().hasConstraint(arrayConstraintId)) {
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
     * @param key the fused type key, e.g. {@code "object.map"}, {@code "metadata.root"}
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
     */
    private static Boolean getBooleanOrNull(JsonObject body, String key) {
        if (!body.has(key)) return null;
        JsonElement el = body.get(key);
        if (el.isJsonNull()) return null;
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
