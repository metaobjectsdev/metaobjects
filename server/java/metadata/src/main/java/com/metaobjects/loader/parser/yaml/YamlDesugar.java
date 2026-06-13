/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.loader.parser.yaml;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.metaobjects.ErrorCode;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.ClassAttribute;
import com.metaobjects.attr.DoubleAttribute;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.LongAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringArrayAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.ChildRequirement;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.source.YamlPosition;
import com.metaobjects.source.YamlPositions;
import com.metaobjects.source.YamlPositions.PositionMap;
import com.metaobjects.source.YamlPositions.SideTable;
import com.metaobjects.util.MetaDataUtil;
import org.yaml.snakeyaml.nodes.MappingNode;
import org.yaml.snakeyaml.nodes.Node;
import org.yaml.snakeyaml.nodes.NodeId;
import org.yaml.snakeyaml.nodes.NodeTuple;
import org.yaml.snakeyaml.nodes.ScalarNode;
import org.yaml.snakeyaml.nodes.SequenceNode;
import org.yaml.snakeyaml.nodes.Tag;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * YAML authoring → canonical desugar (ADR-0006).
 *
 * <p>Java port of the TS reference {@code yaml-desugar.ts} and the Python sibling
 * {@code yaml_desugar.py}. Turns the sugared authoring object (the
 * {@code Map<String, Object>} produced by SnakeYAML's {@code Yaml.load()}) into a
 * canonical-shaped {@link JsonObject} that {@link com.metaobjects.loader.parser.json.CanonicalJsonParser}
 * can consume. The four format-spec sugar rules:</p>
 * <ol>
 *   <li><b>Fused key, subType omittable</b> — a bare {@code type} key resolves to the type's
 *       registry default subType ({@code metadata} → {@code metadata.root},
 *       {@code object} → {@code object.entity}).</li>
 *   <li><b>Scalar-or-map body</b> — a scalar body becomes {@code { name: <scalar> }};
 *       a null body becomes {@code {}}.</li>
 *   <li><b>{@code []} arrays</b> — a trailing {@code []} on the key strips to
 *       {@code isArray: true}.</li>
 *   <li><b>Sigil-free attributes (ADR-0006 D1)</b> — every body key not in
 *       {@link #RESERVED_KEYS} is treated as an inline attribute and re-prefixed with
 *       {@code @} when lowering to canonical JSON. Keys already prefixed with {@code @}
 *       are left as-is (backward-compat). An already-{@code @}-prefixed reserved word
 *       remains an error downstream — {@code CanonicalJsonParser}'s ERR_RESERVED_ATTR
 *       check fires.</li>
 * </ol>
 *
 * <p>In addition, the desugar runs the ADR-0006 D2 type-coercion guard: for every
 * inline attr whose owning {@code (type, subType)} has a declared schema, if the raw
 * Java value's type does not match the declared {@code valueType} AND the Java value
 * is one of YAML 1.2's silently coerced shapes (boolean/number/null), the desugar
 * collects an {@code ERR_YAML_COERCION} error telling the author to quote the value.</p>
 *
 * <p>Pure and total: it never throws. Malformed fragments are collected as
 * {@link CollectedError} entries (a string message + optional stable error code) and
 * a safe placeholder is substituted so {@code CanonicalJsonParser} does not
 * double-report.</p>
 *
 * @since 7.0.0
 */
public final class YamlDesugar {

    /** Canonical attribute prefix — every sigil-free body key gets re-prefixed with this. */
    public static final String ATTR_PREFIX = "@";

    /** Separator between type and subType in the fused node key. */
    public static final String TYPE_SUBTYPE_SEPARATOR = ".";

    /** Array suffix on a body key — strips to {@code isArray: true} on the body. */
    public static final String ARRAY_SUFFIX = "[]";

    // -----------------------------------------------------------------------
    // Reserved structural keys (kept bare; never @-prefixed)
    // -----------------------------------------------------------------------

    /** Canonical body key: short name of the node. */
    public static final String KEY_NAME = "name";
    /** Canonical body key: package. */
    public static final String KEY_PACKAGE = "package";
    /** Canonical body key: supertype reference. */
    public static final String KEY_EXTENDS = "extends";
    /** Canonical body key: abstract flag. */
    public static final String KEY_ABSTRACT = "abstract";
    /** Canonical body key: overlay/merge-into flag. */
    public static final String KEY_OVERLAY = "overlay";
    /** Canonical body key: isArray flag. */
    public static final String KEY_IS_ARRAY = "isArray";
    /** Canonical body key: children list. */
    public static final String KEY_CHILDREN = "children";
    /** Canonical body key: value (for attr child nodes). */
    public static final String KEY_VALUE = "value";

    /** All reserved body keys — kept bare and never coerced to {@code @}-attributes. */
    public static final Set<String> RESERVED_KEYS = Set.of(
        KEY_NAME, KEY_PACKAGE, KEY_EXTENDS, KEY_ABSTRACT, KEY_OVERLAY,
        KEY_IS_ARRAY, KEY_CHILDREN, KEY_VALUE
    );

    /** Package separator ({@code ::}) — used to prepend a parent package per the legacy rule. */
    private static final String PKG_SEPARATOR = MetaDataUtil.SEP;

    /**
     * FR-032 (ADR-0032) — the bare (sigil-free) inline attribute names whose VALUE is a
     * metadata reference subject to FQN expansion. In canonical JSON these are {@code @}-prefixed
     * ({@code @objectRef}, …). The structural {@code extends} key is handled separately (it is not
     * {@code @}-prefixed). {@code @from}/{@code @of}/{@code @via} carry an entity head with a
     * possible dotted relationship/field tail — {@link MetaDataUtil#expandRef} preserves the tail.
     */
    private static final Set<String> REF_BEARING_ATTR_NAMES = Set.of(
        "objectRef", "references", "from", "of", "via",
        "payloadRef", "responseRef", "parameterRef"
    );

    private YamlDesugar() {
        // Utility class.
    }

    // -----------------------------------------------------------------------
    // FR-032 (ADR-0032) — reference expansion helpers
    // -----------------------------------------------------------------------

    /**
     * FR-032 — compute a node's effective package from its raw {@code package} body key
     * (inheriting {@code parentPkg} when absent). Mirrors the TS {@code effectivePackageFor}:
     * the legacy {@code expandPackageForPath} rule prepends the parent when the child's
     * {@code package} value starts with {@code ::}; otherwise it is used as-is. The
     * {@code package} attribute itself is NEVER ref-expanded — it is the node's identity.
     */
    private static String effectivePackageFor(String rawPkg, String parentPkg) {
        if (rawPkg == null) return parentPkg;
        if (!parentPkg.isEmpty() && rawPkg.startsWith(PKG_SEPARATOR)) {
            return parentPkg + rawPkg;
        }
        return rawPkg;
    }

    /**
     * FR-032 — true when {@code outKey} is a ref-bearing key whose String value must be
     * FQN-expanded: the reserved {@code extends} key, or an {@code @}-prefixed inline attr
     * whose bare name is in {@link #REF_BEARING_ATTR_NAMES}.
     */
    private static boolean isRefBearingKey(String outKey) {
        if (KEY_EXTENDS.equals(outKey)) return true;
        if (outKey.startsWith(ATTR_PREFIX)) {
            return REF_BEARING_ATTR_NAMES.contains(outKey.substring(ATTR_PREFIX.length()));
        }
        return false;
    }

    /**
     * FR-032 — expand {@code value} when {@code outKey} is a ref-bearing key, else return it
     * unchanged. Convenience wrapper that combines {@link #isRefBearingKey} + {@link #expandRefValue}.
     */
    private static JsonElement maybeExpandRef(String outKey, JsonElement value, String nodePkg,
                                              List<CollectedError> errors, String path) {
        if (isRefBearingKey(outKey)) {
            return expandRefValue(value, nodePkg, outKey, errors, path);
        }
        return value;
    }

    /** Coerce a raw Java value to a String, or {@code null} if it is not a String. */
    private static String asStringOrNull(Object v) {
        return (v instanceof String) ? (String) v : null;
    }

    /**
     * FR-032 — read the {@code package} body key (a scalar) from a SnakeYAML body
     * {@link Node}, or {@code null} when absent / not a scalar string. Used to seed the
     * node's effective package context for ref expansion.
     */
    private static String packageKeyFromYamlBody(Node rawBody) {
        if (rawBody == null || rawBody.getNodeId() != NodeId.mapping) return null;
        for (NodeTuple bt : ((MappingNode) rawBody).getValue()) {
            if (bt.getKeyNode().getNodeId() != NodeId.scalar) continue;
            if (KEY_PACKAGE.equals(((ScalarNode) bt.getKeyNode()).getValue())) {
                Node v = bt.getValueNode();
                if (v != null && v.getNodeId() == NodeId.scalar) {
                    return ((ScalarNode) v).getValue();
                }
                return null;
            }
        }
        return null;
    }

    /**
     * FR-032 — expand a ref-bearing value to FQN. A ref value is a single string (most refs)
     * or a string-array ({@code @references} can carry multiple); {@link MetaDataUtil#expandRef}
     * preserves any FR-024 dotted child suffix. A parent-relative over-drop throws inside
     * {@code expandRef}; we collect it as {@code ERR_BAD_ATTR_VALUE} and pass the raw value
     * through so a single actionable error surfaces.
     */
    private static JsonElement expandRefValue(JsonElement value, String nodePkg, String refLabel,
                                              List<CollectedError> errors, String path) {
        if (value == null) return value;
        if (value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) {
            try {
                return new JsonPrimitive(MetaDataUtil.expandRef(value.getAsString(), nodePkg));
            } catch (RuntimeException ex) {
                errors.add(new CollectedError(
                    "Cannot expand reference '" + refLabel + "' at " + path + ": " + ex.getMessage(),
                    ErrorCode.ERR_BAD_ATTR_VALUE));
                return value;
            }
        }
        if (value.isJsonArray()) {
            JsonArray src = value.getAsJsonArray();
            JsonArray out = new JsonArray(src.size());
            for (JsonElement el : src) {
                if (el != null && el.isJsonPrimitive() && el.getAsJsonPrimitive().isString()) {
                    out.add(expandRefValue(el, nodePkg, refLabel, errors, path));
                } else {
                    out.add(el);
                }
            }
            return out;
        }
        return value;
    }

    // -----------------------------------------------------------------------
    // Collected error + result types
    // -----------------------------------------------------------------------

    /**
     * A collected desugar problem — message plus optional stable error code.
     * Absent codes map to {@link ErrorCode#ERR_MALFORMED_YAML} in {@link ParserYaml}.
     */
    public static final class CollectedError {
        public final String message;
        public final ErrorCode code;

        public CollectedError(String message, ErrorCode code) {
            this.message = message;
            this.code = code;
        }

        public CollectedError(String message) {
            this(message, null);
        }
    }

    /** Outcome of desugaring a parsed-YAML document. */
    public static final class DesugarResult {
        /** The canonical-shaped object; {@code {}} when the document was unusable. */
        public final JsonObject canonical;
        /** Collected desugar problems (never thrown). */
        public final List<CollectedError> errors;
        /**
         * FR5b — side table of {@code JsonObject → PositionMap} populated when the
         * desugar was invoked with a SnakeYAML {@link Node} input (via
         * {@link #desugar(Node, MetaDataRegistry)}); empty when invoked with the
         * legacy {@code Object} input (no position info available from
         * {@code Yaml.load()}).
         */
        public final SideTable positions;

        public DesugarResult(JsonObject canonical, List<CollectedError> errors) {
            this(canonical, errors, new SideTable());
        }

        public DesugarResult(JsonObject canonical, List<CollectedError> errors,
                             SideTable positions) {
            this.canonical = canonical;
            this.errors = errors;
            this.positions = positions;
        }
    }

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    /**
     * Desugar a parsed-YAML authoring document into a canonical-shaped {@link JsonObject}.
     *
     * <p>Legacy entry point — takes the raw SnakeYAML-parsed object (typically a
     * {@link Map}) from {@code Yaml.load()}. The returned {@link DesugarResult} carries
     * an EMPTY {@link SideTable} because the {@code Object} shape has no source-position
     * information; for FR5b position tracking use the {@link #desugar(Node, MetaDataRegistry)}
     * overload with input from {@code Yaml.compose(reader)}.</p>
     *
     * @param input    the raw SnakeYAML-parsed object (typically a {@link Map}); never thrown on
     * @param registry the type registry used for default-subType resolution + coercion checks
     * @return the canonical JSON object and any collected diagnostics
     */
    public static DesugarResult desugar(Object input, MetaDataRegistry registry) {
        List<CollectedError> errors = new ArrayList<>();
        // FR-032: the root package context starts empty; each node's own `package` body key
        // seeds the context threaded down to its children for ref expansion.
        JsonObject node = desugarNode(input, registry, errors, "<root>", "");
        JsonObject canonical = node != null ? node : new JsonObject();
        return new DesugarResult(canonical, errors);
    }

    /**
     * FR5b — desugar entry point that takes a SnakeYAML {@link Node} tree (from
     * {@code Yaml.compose(reader)}) so source-position marks are preserved.
     *
     * <p>Walks the Node tree, building the canonical {@link JsonObject} in lockstep
     * with a {@link SideTable} of {@code JsonObject → PositionMap} entries. The four
     * sugar rules carry positions through as follows:</p>
     * <ul>
     *   <li><b>Rule 1</b> (bare type → fused) — wrapper-key position recorded under
     *       the canonical (fused) key on the wrapper object's PositionMap.</li>
     *   <li><b>Rule 2</b> (scalar body → {@code name}) — the synthesized {@code name}
     *       slot inherits the wrapper key's position (the body has no YAML-side key).</li>
     *   <li><b>Rule 3</b> ({@code []} array suffix) — wrapper-key position recorded
     *       under the canonical (suffixless) key.</li>
     *   <li><b>Rule 4 / D1</b> (sigil-free attr → {@code @}-prefixed) — body-key
     *       position re-keyed under the rewritten {@code @<name>} canonical key.</li>
     * </ul>
     *
     * @param input    SnakeYAML node tree (from {@code Yaml.compose}); {@code null} →
     *                 empty canonical + a "must be a mapping" error
     * @param registry type registry used for default-subType resolution + coercion checks
     * @return the canonical JSON object, any collected diagnostics, and the side table
     */
    public static DesugarResult desugar(Node input, MetaDataRegistry registry) {
        List<CollectedError> errors = new ArrayList<>();
        SideTable positions = new SideTable();
        // FR-032: root package context starts empty (see the Object-tree entry point).
        JsonObject node = desugarNodeFromYaml(input, registry, errors, positions, "<root>", "");
        JsonObject canonical = node != null ? node : new JsonObject();
        return new DesugarResult(canonical, errors, positions);
    }

    // -----------------------------------------------------------------------
    // Node-level desugar
    // -----------------------------------------------------------------------

    /**
     * Desugar one node — a single-key mapping {@code { "type.subType": body }}.
     * Returns the canonical node object, or {@code null} if {@code input} is not a usable
     * node (the caller substitutes a placeholder).
     */
    private static JsonObject desugarNode(Object input, MetaDataRegistry registry,
                                          List<CollectedError> errors, String path,
                                          String parentPkg) {
        if (!(input instanceof Map)) {
            errors.add(new CollectedError(
                "Node at " + path + " must be a mapping with one type key"));
            return null;
        }
        @SuppressWarnings("unchecked")
        Map<Object, Object> rawMap = (Map<Object, Object>) input;
        if (rawMap.size() != 1) {
            String found;
            if (rawMap.isEmpty()) {
                found = "none";
            } else {
                List<String> keyStrs = new ArrayList<>(rawMap.size());
                for (Object k : rawMap.keySet()) keyStrs.add(String.valueOf(k));
                found = String.join(", ", keyStrs);
            }
            errors.add(new CollectedError(
                "Node at " + path + " must have exactly one type key (found: " + found + ")"));
            return null;
        }
        Object rawKeyObj = rawMap.keySet().iterator().next();
        if (!(rawKeyObj instanceof String)) {
            errors.add(new CollectedError(
                "Node key at " + path + " must be a string, got "
                    + (rawKeyObj == null ? "null" : rawKeyObj.getClass().getSimpleName())));
            return null;
        }
        String rawKey = (String) rawKeyObj;
        Object rawBody = rawMap.get(rawKeyObj);

        // Rule 4: a trailing "[]" on the key → isArray.
        String key = rawKey;
        boolean isArray = false;
        if (key.endsWith(ARRAY_SUFFIX)) {
            key = key.substring(0, key.length() - ARRAY_SUFFIX.length());
            isArray = true;
        }

        // Rule 1: a bare `type` key → the type's registry default subType.
        String canonicalKey = resolveKey(key, registry, errors, path);

        // FR-032: this node's effective package context (its own `package` body key, else
        // inherited). Used to expand its ref-bearing attrs AND threaded to its children.
        String rawPkg = (rawBody instanceof Map) ? asStringOrNull(((Map<?, ?>) rawBody).get(KEY_PACKAGE)) : null;
        String nodePkg = effectivePackageFor(rawPkg, parentPkg);

        // Rule 2: a scalar body → { name: <scalar> }.
        JsonObject body = desugarBody(rawBody, registry, canonicalKey, errors, path, nodePkg);

        // Rule 4 (cont.): stamp isArray onto the canonical body.
        if (isArray) {
            body.addProperty(KEY_IS_ARRAY, true);
        }

        // Recurse into children — when children is a YAML list, desugar each element.
        if (body.has(KEY_CHILDREN)) {
            JsonElement childrenEl = body.get(KEY_CHILDREN);
            if (childrenEl.isJsonArray()) {
                // Already JSON-shaped (we re-injected it ourselves below) — leave it.
                // This branch isn't reachable on a first pass since desugarBody copies
                // raw values as-is; recursion happens in the rawBody branch.
            }
        }

        // The body produced by desugarBody contains the children list as the raw Java
        // list (wrapped in a JsonElement). We need to recurse into each element.
        Object rawChildren = (rawBody instanceof Map)
            ? ((Map<?, ?>) rawBody).get(KEY_CHILDREN)
            : null;
        if (rawChildren instanceof List) {
            List<?> list = (List<?>) rawChildren;
            JsonArray children = new JsonArray(list.size());
            for (int i = 0; i < list.size(); i++) {
                String childPath = path + "." + KEY_CHILDREN + "[" + i + "]";
                JsonObject child = desugarNode(list.get(i), registry, errors, childPath, nodePkg);
                // On a bad child keep an empty-object placeholder so sibling indices
                // stay stable; the error is already collected.
                children.add(child != null ? child : new JsonObject());
            }
            body.add(KEY_CHILDREN, children);
        }
        // A non-list `children` value is left as the converted JSON form; the
        // canonical parser reports a malformed-children warning.

        JsonObject wrapper = new JsonObject();
        wrapper.add(canonicalKey, body);
        return wrapper;
    }

    /** Rule 1 — resolve a possibly-bare key to a fused {@code type.subType} token. */
    private static String resolveKey(String key, MetaDataRegistry registry,
                                     List<CollectedError> errors, String path) {
        if (key.indexOf(TYPE_SUBTYPE_SEPARATOR.charAt(0)) >= 0) {
            return key; // already fused
        }
        String subType = registry.defaultSubTypeOf(key);
        if (subType == null) {
            errors.add(new CollectedError(
                "Cannot resolve subType for bare type key '" + key + "' at " + path
                    + " — type '" + key + "' has no default subType; "
                    + "write the full 'type.subType'"));
            return key; // pass through; canonical parser reports the unknown type
        }
        return key + TYPE_SUBTYPE_SEPARATOR + subType;
    }

    // -----------------------------------------------------------------------
    // Body-level desugar (Rules 2, 5 + D2 type-coercion guard)
    // -----------------------------------------------------------------------

    /**
     * Rule 2 + 5 — normalize a node body into a canonical mapping.
     *
     * <p>Reserved structural keys stay bare; every other key is treated as an inline
     * attribute and {@code @}-prefixed (Rule 5 / ADR-0006 D1). Keys already starting
     * with {@code @} are kept as-authored so the awkward {@code "@column": foo} form
     * remains accepted.</p>
     *
     * <p>Also runs the D2 type-coercion guard.</p>
     */
    private static JsonObject desugarBody(Object rawBody, MetaDataRegistry registry,
                                          String canonicalKey,
                                          List<CollectedError> errors, String path,
                                          String nodePkg) {
        JsonObject out = new JsonObject();
        if (rawBody == null) {
            // An empty body (`field.string:` with nothing after) → an empty node.
            return out;
        }
        if (rawBody instanceof String || rawBody instanceof Number || rawBody instanceof Boolean) {
            out.add(KEY_NAME, toJsonPrimitive(rawBody));
            return out;
        }
        if (rawBody instanceof List) {
            errors.add(new CollectedError(
                "Node body at " + path + " must be a scalar or mapping, not a list"));
            return out;
        }
        if (!(rawBody instanceof Map)) {
            // Catch-all for other shapes.
            errors.add(new CollectedError(
                "Node body at " + path + " must be a scalar or mapping"));
            return out;
        }
        @SuppressWarnings("unchecked")
        Map<Object, Object> src = (Map<Object, Object>) rawBody;
        Map<String, ChildRequirement> attrSchemaIndex = buildAttrSchemaIndex(registry, canonicalKey);
        ParentKey parent = splitCanonicalKey(canonicalKey);

        for (Map.Entry<Object, Object> entry : src.entrySet()) {
            Object keyObj = entry.getKey();
            if (!(keyObj instanceof String)) {
                errors.add(new CollectedError(
                    "Body key at " + path + " must be a string, got "
                        + (keyObj == null ? "null" : keyObj.getClass().getSimpleName())));
                continue;
            }
            String key = (String) keyObj;
            Object value = entry.getValue();

            // KEY_CHILDREN is reserved but its array is recursed-into by the caller.
            // We still copy the raw value here as a placeholder so the body retains the
            // key — the caller will replace it with a JsonArray of desugared children.
            if (key.equals(KEY_CHILDREN)) {
                out.add(KEY_CHILDREN, toJsonElement(value));
                continue;
            }

            if (RESERVED_KEYS.contains(key) || key.startsWith(ATTR_PREFIX)) {
                // FR-032: expand a ref-bearing value (the reserved `extends` key, or an
                // already-`@`-prefixed ref attr) to FQN; the `package` key is never expanded.
                out.add(key, maybeExpandRef(key, toJsonElement(value), nodePkg, errors, path));
                // D2 also applies to author-written @-keys (the awkward form).
                if (key.startsWith(ATTR_PREFIX)) {
                    String attrName = key.substring(ATTR_PREFIX.length());
                    if (!attrName.isEmpty() && !RESERVED_KEYS.contains(attrName)) {
                        checkCoercion(attrName, value, attrSchemaIndex, registry, parent,
                            errors, path);
                    }
                }
            } else {
                // FR-032: a bare (sigil-free) ref-bearing attr is expanded to FQN too.
                String outKey = ATTR_PREFIX + key;
                out.add(outKey, maybeExpandRef(outKey, toJsonElement(value), nodePkg, errors, path));
                checkCoercion(key, value, attrSchemaIndex, registry, parent, errors, path);
            }
        }
        return out;
    }

    /** Split a fused {@code type.subType} canonical key. */
    private static ParentKey splitCanonicalKey(String canonicalKey) {
        int dot = canonicalKey.indexOf(TYPE_SUBTYPE_SEPARATOR.charAt(0));
        if (dot < 0) return new ParentKey(canonicalKey, "");
        return new ParentKey(canonicalKey.substring(0, dot), canonicalKey.substring(dot + 1));
    }

    private static final class ParentKey {
        final String type;
        final String subType;
        ParentKey(String type, String subType) { this.type = type; this.subType = subType; }
    }

    // -----------------------------------------------------------------------
    // Java → Gson conversion (preserves YAML scalar types so the canonical
    // parser sees the same shapes a hand-authored canonical JSON would).
    // -----------------------------------------------------------------------

    private static JsonElement toJsonElement(Object value) {
        if (value == null) return JsonNull.INSTANCE;
        if (value instanceof JsonElement) return (JsonElement) value;
        if (value instanceof String) return new JsonPrimitive((String) value);
        if (value instanceof Boolean) return new JsonPrimitive((Boolean) value);
        if (value instanceof Number) return new JsonPrimitive((Number) value);
        if (value instanceof List) {
            List<?> list = (List<?>) value;
            JsonArray arr = new JsonArray(list.size());
            for (Object el : list) arr.add(toJsonElement(el));
            return arr;
        }
        if (value instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<Object, Object> m = (Map<Object, Object>) value;
            JsonObject obj = new JsonObject();
            for (Map.Entry<Object, Object> e : m.entrySet()) {
                String k = String.valueOf(e.getKey());
                obj.add(k, toJsonElement(e.getValue()));
            }
            return obj;
        }
        // Fallback: stringify
        return new JsonPrimitive(String.valueOf(value));
    }

    private static JsonPrimitive toJsonPrimitive(Object value) {
        if (value instanceof String) return new JsonPrimitive((String) value);
        if (value instanceof Boolean) return new JsonPrimitive((Boolean) value);
        if (value instanceof Number) return new JsonPrimitive((Number) value);
        return new JsonPrimitive(String.valueOf(value));
    }

    // -----------------------------------------------------------------------
    // D2 type-coercion guard
    // -----------------------------------------------------------------------

    /**
     * Build a {@code name → ChildRequirement} map of attr-declared children for the
     * given canonical key. Returns {@code null} when the (type, subType) is not
     * registered (open schema — no coercion check possible).
     */
    private static Map<String, ChildRequirement> buildAttrSchemaIndex(MetaDataRegistry registry,
                                                                     String canonicalKey) {
        int dot = canonicalKey.indexOf(TYPE_SUBTYPE_SEPARATOR.charAt(0));
        if (dot < 0) return null;
        String type = canonicalKey.substring(0, dot);
        String subType = canonicalKey.substring(dot + 1);
        if (registry.getTypeDefinition(type, subType) == null) return null;

        List<ChildRequirement> requirements = registry.getChildRequirements(type, subType);
        if (requirements == null || requirements.isEmpty()) return null;

        Map<String, ChildRequirement> idx = new HashMap<>();
        for (ChildRequirement req : requirements) {
            if (!MetaAttribute.TYPE_ATTR.equals(req.getExpectedType())) continue;
            String name = req.getName();
            if (name == null || "*".equals(name)) continue;
            // First-wins: don't overwrite a more specific declaration with an inherited dup.
            idx.putIfAbsent(name, req);
        }
        return idx.isEmpty() ? null : Collections.unmodifiableMap(idx);
    }

    /**
     * Check a single attr value against its declared schema's {@code expectedSubType}.
     * Emits {@code ERR_YAML_COERCION} when YAML 1.2's core schema silently changed the
     * Java type (boolean/number/null where a string/stringarray was declared, or vice
     * versa for booleans/numbers).
     */
    private static void checkCoercion(String attrName, Object raw,
                                      Map<String, ChildRequirement> schemaIndex,
                                      MetaDataRegistry registry,
                                      ParentKey parent,
                                      List<CollectedError> errors, String path) {
        if (schemaIndex == null) return;
        ChildRequirement spec = schemaIndex.get(attrName);
        if (spec == null) return;

        String declaredValueType = spec.getExpectedSubType();
        if (declaredValueType == null || "*".equals(declaredValueType)) return;

        // Array-typed attrs are detected via the registered
        // "<type>.<subType>.<attrName>.array" constraint — the same hook
        // CanonicalJsonParser uses for bare-string desugar. When present, treat
        // the value as an array of the declared element subType.
        boolean isArrayAttr = isStringArraySubType(declaredValueType)
            || isArrayConstraintRegistered(registry, parent, attrName);

        if (isArrayAttr) {
            checkArrayCoercion(attrName, raw, declaredValueType, errors, path);
            return;
        }

        if (StringAttribute.SUBTYPE_STRING.equals(declaredValueType)
            || ClassAttribute.SUBTYPE_CLASS.equals(declaredValueType)) {
            if (!(raw instanceof String)) emitCoercion(attrName, raw, "string", errors, path);
            return;
        }
        if (BooleanAttribute.SUBTYPE_BOOLEAN.equals(declaredValueType)) {
            if (!(raw instanceof Boolean)) emitCoercion(attrName, raw, "boolean", errors, path);
            return;
        }
        if (IntAttribute.SUBTYPE_INT.equals(declaredValueType)
            || LongAttribute.SUBTYPE_LONG.equals(declaredValueType)
            || DoubleAttribute.SUBTYPE_DOUBLE.equals(declaredValueType)) {
            // Java: Boolean is NOT a Number, so this catches `true`/`false` correctly.
            if (!(raw instanceof Number)) emitCoercion(attrName, raw, "number", errors, path);
            return;
        }
        // Object-shaped attrs (properties, custom) — accept any object/array, no YAML
        // coercion path applies.
    }

    private static boolean isStringArraySubType(String declared) {
        return StringArrayAttribute.SUBTYPE_STRING_ARRAY.equals(declared);
    }

    /**
     * True if the registry carries an array constraint for
     * {@code <parentType>.<parentSubType>.<attrName>.array} (the convention used by
     * {@link com.metaobjects.registry.AttributeConstraintBuilder.AttributeTypeBuilder#asArray()}
     * and probed by {@link com.metaobjects.loader.parser.json.CanonicalJsonParser} for
     * bare-string-to-array desugar). When true, the attr accepts an array of
     * {@code declaredValueType} elements.
     */
    private static boolean isArrayConstraintRegistered(MetaDataRegistry registry,
                                                       ParentKey parent, String attrName) {
        if (registry == null || parent == null || parent.subType.isEmpty()) return false;
        String constraintId = parent.type + TYPE_SUBTYPE_SEPARATOR + parent.subType
            + TYPE_SUBTYPE_SEPARATOR + attrName + ".array";
        return registry.hasConstraint(constraintId);
    }

    /**
     * Coercion check for an array attr.
     *
     * <p>Element subType is encoded by {@code declaredElementSubType} — for stringarray
     * (or string-with-array-constraint) attrs, every element must be a {@code String}; a
     * bare string at the value position is the legitimate one-element authoring
     * shorthand for a string-array attr (the parser's existing bare-string desugar
     * wraps it), and IS NOT a coercion.</p>
     */
    private static void checkArrayCoercion(String attrName, Object raw,
                                           String declaredElementSubType,
                                           List<CollectedError> errors, String path) {
        // A bare string at the value position is the legitimate one-element authoring
        // shorthand — parallels TS / Python.
        if (raw instanceof String) return;
        if (!(raw instanceof List)) {
            String expected = isStringArrayLike(declaredElementSubType)
                ? "string-array (or single string)"
                : declaredElementSubType + "-array (or single " + declaredElementSubType + ")";
            emitCoercion(attrName, raw, expected, errors, path);
            return;
        }
        // For a list, check every element against the declared element subType.
        List<?> list = (List<?>) raw;
        for (int i = 0; i < list.size(); i++) {
            Object el = list.get(i);
            if (!matchesElementSubType(el, declaredElementSubType)) {
                emitCoercion(attrName + "[" + i + "]", el,
                    elementExpectedLabel(declaredElementSubType), errors, path);
            }
        }
    }

    private static boolean isStringArrayLike(String elementSubType) {
        return StringAttribute.SUBTYPE_STRING.equals(elementSubType)
            || StringArrayAttribute.SUBTYPE_STRING_ARRAY.equals(elementSubType)
            || ClassAttribute.SUBTYPE_CLASS.equals(elementSubType);
    }

    private static boolean matchesElementSubType(Object el, String elementSubType) {
        if (isStringArrayLike(elementSubType)) {
            return el instanceof String;
        }
        if (BooleanAttribute.SUBTYPE_BOOLEAN.equals(elementSubType)) {
            return el instanceof Boolean;
        }
        if (IntAttribute.SUBTYPE_INT.equals(elementSubType)
            || LongAttribute.SUBTYPE_LONG.equals(elementSubType)
            || DoubleAttribute.SUBTYPE_DOUBLE.equals(elementSubType)) {
            return el instanceof Number && !(el instanceof Boolean);
        }
        // Unknown element subType — accept anything (open).
        return true;
    }

    private static String elementExpectedLabel(String elementSubType) {
        if (isStringArrayLike(elementSubType)) return "string (in string-array)";
        if (BooleanAttribute.SUBTYPE_BOOLEAN.equals(elementSubType)) {
            return "boolean (in boolean-array)";
        }
        if (IntAttribute.SUBTYPE_INT.equals(elementSubType)
            || LongAttribute.SUBTYPE_LONG.equals(elementSubType)
            || DoubleAttribute.SUBTYPE_DOUBLE.equals(elementSubType)) {
            return "number (in number-array)";
        }
        return elementSubType + " (in array)";
    }

    // -----------------------------------------------------------------------
    // ERR_YAML_COERCION message formatting
    // -----------------------------------------------------------------------

    /**
     * Build the "quote this value" error. The shape is intentionally explicit so AI
     * authors can act on it: it identifies the attr, the (coerced) Java value, its Java
     * type, the declared expected type, and a one-line fix hint.
     */
    private static void emitCoercion(String attrName, Object raw, String expected,
                                     List<CollectedError> errors, String path) {
        String actualType = coercedTypeName(raw);
        String literal = literalRepr(raw);
        errors.add(new CollectedError(
            "Attribute '@" + attrName + "' at " + path + ": expected " + expected
                + " but got " + actualType + " (" + literal + "). "
                + "YAML 1.2 silently coerced an unquoted value — quote it in YAML: "
                + "'@" + attrName + ": \"" + literal + "\"' not '@" + attrName + ": " + literal + "'.",
            ErrorCode.ERR_YAML_COERCION));
    }

    private static String coercedTypeName(Object raw) {
        if (raw == null) return "null";
        if (raw instanceof Boolean) return "boolean";
        if (raw instanceof Number) return "number";
        if (raw instanceof String) return "string";
        if (raw instanceof List) return "array";
        if (raw instanceof Map) return "object";
        return raw.getClass().getSimpleName();
    }

    private static String literalRepr(Object raw) {
        if (raw == null) return "null";
        if (raw instanceof Boolean) return ((Boolean) raw) ? "true" : "false";
        if (raw instanceof Number) return String.valueOf(raw);
        if (raw instanceof String) return (String) raw;
        if (raw instanceof List) return Arrays.toString(((List<?>) raw).toArray());
        return String.valueOf(raw);
    }

    // =======================================================================
    // FR5b — SnakeYAML Node-tree desugar path
    //
    // Mirrors the Object-tree path above but walks SnakeYAML's Node tree so
    // each scalar key's start-mark is available for the position side table.
    // The four sugar rules are applied identically; the only structural
    // difference is that this path attaches a PositionMap to every produced
    // wrapper / body JsonObject via the supplied SideTable.
    //
    // Java port of:
    //   server/csharp/MetaObjects/YamlDesugar.cs (Rule-1–5 + position carrier)
    //   server/typescript/packages/metadata/src/core/yaml-desugar.ts (reference)
    // =======================================================================

    /**
     * Desugar one node from a SnakeYAML {@link Node} tree — a single-key mapping
     * {@code { "type.subType": body }}.
     *
     * <p>Returns the canonical wrapper {@link JsonObject}, or {@code null} when the
     * input is not a usable node (the caller substitutes a placeholder). Attaches
     * a {@link PositionMap} entry on the wrapper for the canonical key, and on the
     * produced body for each body key (after Rule-4 / Rule-2 rewrites).</p>
     */
    private static JsonObject desugarNodeFromYaml(Node input, MetaDataRegistry registry,
                                                  List<CollectedError> errors,
                                                  SideTable positions, String path,
                                                  String parentPkg) {
        if (input == null) {
            errors.add(new CollectedError(
                "Node at " + path + " must be a mapping with one type key"));
            return null;
        }
        if (input.getNodeId() != NodeId.mapping) {
            errors.add(new CollectedError(
                "Node at " + path + " must be a mapping with one type key"));
            return null;
        }
        MappingNode map = (MappingNode) input;
        List<NodeTuple> tuples = map.getValue();
        if (tuples.size() != 1) {
            String found;
            if (tuples.isEmpty()) {
                found = "none";
            } else {
                List<String> keyStrs = new ArrayList<>(tuples.size());
                for (NodeTuple t : tuples) keyStrs.add(yamlNodeToString(t.getKeyNode()));
                found = String.join(", ", keyStrs);
            }
            errors.add(new CollectedError(
                "Node at " + path + " must have exactly one type key (found: " + found + ")"));
            return null;
        }
        NodeTuple entry = tuples.get(0);
        Node rawKeyNode = entry.getKeyNode();
        if (rawKeyNode.getNodeId() != NodeId.scalar) {
            errors.add(new CollectedError(
                "Node key at " + path + " must be a string"));
            return null;
        }
        ScalarNode keyScalar = (ScalarNode) rawKeyNode;
        String rawKey = keyScalar.getValue();
        if (rawKey == null) {
            errors.add(new CollectedError(
                "Node key at " + path + " must be a string"));
            return null;
        }
        Node rawBody = entry.getValueNode();

        // FR5b — capture the wrapper-key's YAML position BEFORE any rewrites.
        // The author's raw key (with possible `[]` suffix and possibly omitted
        // subType) is at this (line, col); we emit this position under the
        // CANONICAL key on the wrapper's position map.
        YamlPosition wrapperKeyPos = YamlPositions.positionOf(keyScalar);

        // Rule 4: a trailing "[]" on the key → isArray.
        String key = rawKey;
        boolean isArray = false;
        if (key.endsWith(ARRAY_SUFFIX)) {
            key = key.substring(0, key.length() - ARRAY_SUFFIX.length());
            isArray = true;
        }

        // Rule 1: a bare `type` key → the type's registry default subType.
        String canonicalKey = resolveKey(key, registry, errors, path);

        // FR-032: this node's effective package context (its own `package` body key, else
        // inherited). Used to expand its ref-bearing attrs AND threaded to its children.
        String rawPkg = packageKeyFromYamlBody(rawBody);
        String nodePkg = effectivePackageFor(rawPkg, parentPkg);

        // Rule 2: a scalar body → { name: <scalar> }. The body-builder also gets
        // the wrapper-key position so Rule-2 synthesis (name slot) can inherit it.
        JsonObject body = desugarBodyFromYaml(rawBody, registry, canonicalKey, errors,
            positions, path, wrapperKeyPos, nodePkg);

        // Rule 4 (cont.): stamp isArray onto the canonical body.
        if (isArray) {
            body.addProperty(KEY_IS_ARRAY, true);
        }

        // Recurse into children (a YAML sequence) — desugar each element so deeper
        // wrappers carry their own positions.
        if (rawBody != null && rawBody.getNodeId() == NodeId.mapping) {
            MappingNode bodyMap = (MappingNode) rawBody;
            for (NodeTuple bt : bodyMap.getValue()) {
                if (bt.getKeyNode().getNodeId() != NodeId.scalar) continue;
                String bk = ((ScalarNode) bt.getKeyNode()).getValue();
                if (!KEY_CHILDREN.equals(bk)) continue;
                Node childrenNode = bt.getValueNode();
                if (childrenNode != null && childrenNode.getNodeId() == NodeId.sequence) {
                    SequenceNode seq = (SequenceNode) childrenNode;
                    JsonArray children = new JsonArray(seq.getValue().size());
                    for (int i = 0; i < seq.getValue().size(); i++) {
                        String childPath = path + "." + KEY_CHILDREN + "[" + i + "]";
                        JsonObject child = desugarNodeFromYaml(seq.getValue().get(i),
                            registry, errors, positions, childPath, nodePkg);
                        children.add(child != null ? child : new JsonObject());
                    }
                    body.add(KEY_CHILDREN, children);
                }
                break;
            }
        }

        JsonObject wrapper = new JsonObject();
        wrapper.add(canonicalKey, body);

        // FR5b — stamp wrapper-level position-by-key map (canonicalKey → raw-key pos).
        // The transformation rawKey → canonicalKey (Rule 1's fuse + Rule 4's `[]`
        // strip) preserves the position; the canonical wrapper still resolves to the
        // YAML line that authored it.
        if (wrapperKeyPos != null) {
            PositionMap wp = new PositionMap();
            wp.set(canonicalKey, wrapperKeyPos);
            positions.setMap(wrapper, wp);
        }
        return wrapper;
    }

    /**
     * Rule 2 + 4 — normalize a node body (from a SnakeYAML {@link Node}) into a
     * canonical mapping, attaching a {@link PositionMap} for the body keys.
     *
     * <p>Reserved structural keys stay bare; every other key is {@code @}-prefixed
     * (Rule 4 / ADR-0006 D1). The body-key's position is re-keyed under the
     * rewritten output key.</p>
     *
     * <p>Also runs the D2 type-coercion guard against the registry-declared
     * value types for each attr.</p>
     */
    private static JsonObject desugarBodyFromYaml(Node rawBody, MetaDataRegistry registry,
                                                  String canonicalKey,
                                                  List<CollectedError> errors,
                                                  SideTable positions, String path,
                                                  YamlPosition wrapperKeyPos,
                                                  String nodePkg) {
        JsonObject out = new JsonObject();
        if (rawBody == null) {
            // Empty body (`field.string:` with nothing) → empty node, no body positions.
            return out;
        }

        if (rawBody.getNodeId() == NodeId.scalar) {
            ScalarNode scalar = (ScalarNode) rawBody;
            if (isYamlNull(scalar)) {
                return out;
            }
            out.add(KEY_NAME, scalarToJsonElementYaml(scalar));
            // FR5b — the synthesized `{ name: rawBody }` has no YAML-side key;
            // attribute the `name` slot to the wrapper-key's position. Mirrors C#
            // YamlDesugar.cs Rule-2 inheritance.
            if (wrapperKeyPos != null) {
                PositionMap pm = new PositionMap();
                pm.set(KEY_NAME, wrapperKeyPos);
                positions.setMap(out, pm);
            }
            return out;
        }

        if (rawBody.getNodeId() == NodeId.sequence) {
            errors.add(new CollectedError(
                "Node body at " + path + " must be a scalar or mapping, not a list"));
            return out;
        }

        if (rawBody.getNodeId() != NodeId.mapping) {
            errors.add(new CollectedError(
                "Node body at " + path + " must be a scalar or mapping"));
            return out;
        }

        MappingNode src = (MappingNode) rawBody;
        Map<String, ChildRequirement> attrSchemaIndex = buildAttrSchemaIndex(registry, canonicalKey);
        ParentKey parent = splitCanonicalKey(canonicalKey);

        // FR5b — translate body-key positions across the sigil-free rewrite. The
        // author's bare `filterable` maps to canonical `@filterable`; we record
        // the position under the rewritten name so the parser's JSONPath lookup
        // (which walks canonical JSON) lands on the right entry.
        PositionMap outPositions = null;

        for (NodeTuple bt : src.getValue()) {
            Node keyNode = bt.getKeyNode();
            if (keyNode.getNodeId() != NodeId.scalar) {
                errors.add(new CollectedError(
                    "Body key at " + path + " must be a string"));
                continue;
            }
            ScalarNode keyScalar = (ScalarNode) keyNode;
            String key = keyScalar.getValue();
            if (key == null) {
                errors.add(new CollectedError(
                    "Body key at " + path + " must be a string"));
                continue;
            }
            Node valueNode = bt.getValueNode();

            YamlPosition bodyKeyPos = YamlPositions.positionOf(keyScalar);
            String outKey;

            // KEY_CHILDREN — copy placeholder; the caller replaces it with the desugared array.
            if (key.equals(KEY_CHILDREN)) {
                out.add(KEY_CHILDREN, yamlNodeToJsonElement(valueNode));
                outKey = KEY_CHILDREN;
            } else if (RESERVED_KEYS.contains(key) || key.startsWith(ATTR_PREFIX)) {
                // FR-032: expand a ref-bearing value (reserved `extends` or an already-`@`-prefixed
                // ref attr) to FQN; the `package` key is never expanded.
                outKey = key;
                out.add(key, maybeExpandRef(key, yamlNodeToJsonElement(valueNode), nodePkg, errors, path));
                if (key.startsWith(ATTR_PREFIX)) {
                    String attrName = key.substring(ATTR_PREFIX.length());
                    if (!attrName.isEmpty() && !RESERVED_KEYS.contains(attrName)) {
                        checkCoercionYaml(attrName, valueNode, attrSchemaIndex, registry,
                            parent, errors, path);
                    }
                }
            } else {
                // Rule 4 (D1) — sigil-free attr: re-prefix with `@` on lowering.
                // FR-032: a bare ref-bearing attr is expanded to FQN too.
                outKey = ATTR_PREFIX + key;
                out.add(outKey, maybeExpandRef(outKey, yamlNodeToJsonElement(valueNode), nodePkg, errors, path));
                checkCoercionYaml(key, valueNode, attrSchemaIndex, registry, parent,
                    errors, path);
            }

            if (bodyKeyPos != null) {
                if (outPositions == null) outPositions = new PositionMap();
                outPositions.set(outKey, bodyKeyPos);
            }
        }
        if (outPositions != null && outPositions.any()) {
            positions.setMap(out, outPositions);
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // SnakeYAML Node → Gson JsonElement (preserves YAML 1.2 core-schema types,
    // including quoted-as-string).
    // -----------------------------------------------------------------------

    private static JsonElement yamlNodeToJsonElement(Node node) {
        if (node == null) return JsonNull.INSTANCE;
        switch (node.getNodeId()) {
            case scalar: return scalarToJsonElementYaml((ScalarNode) node);
            case sequence: {
                SequenceNode seq = (SequenceNode) node;
                JsonArray arr = new JsonArray();
                for (Node el : seq.getValue()) arr.add(yamlNodeToJsonElement(el));
                return arr;
            }
            case mapping: {
                MappingNode m = (MappingNode) node;
                JsonObject obj = new JsonObject();
                for (NodeTuple t : m.getValue()) {
                    Node k = t.getKeyNode();
                    String ks = (k.getNodeId() == NodeId.scalar)
                        ? ((ScalarNode) k).getValue()
                        : k.toString();
                    obj.add(ks, yamlNodeToJsonElement(t.getValueNode()));
                }
                return obj;
            }
            default: return JsonNull.INSTANCE;
        }
    }

    private static JsonElement scalarToJsonElementYaml(ScalarNode scalar) {
        String value = scalar.getValue();
        Tag tag = scalar.getTag();
        if (value == null) return JsonNull.INSTANCE;
        if (Tag.NULL.equals(tag)) return JsonNull.INSTANCE;

        // Quoted scalars → strings. SnakeYAML's PLAIN style returns a null Character
        // from getChar(); only the quoted styles ('\'', '"', '|', '>') have a real char.
        if (isQuotedScalar(scalar)) {
            return new JsonPrimitive(value);
        }

        if (Tag.STR.equals(tag)) return new JsonPrimitive(value);
        if (Tag.BOOL.equals(tag)) {
            Boolean b = parseYamlBool(value);
            return b != null ? new JsonPrimitive(b) : new JsonPrimitive(value);
        }
        if (Tag.INT.equals(tag)) {
            Long l = parseYamlInt(value);
            return l != null ? new JsonPrimitive(l) : new JsonPrimitive(value);
        }
        if (Tag.FLOAT.equals(tag)) {
            Double d = parseYamlFloat(value);
            return d != null ? new JsonPrimitive(d) : new JsonPrimitive(value);
        }

        // Plain scalars — YAML 1.2 core: null/bool first, then int, then float, fallback string.
        if (isPlainYamlNull(value)) return JsonNull.INSTANCE;
        Boolean b = parseYamlBool(value);
        if (b != null) return new JsonPrimitive(b);
        Long l = parseYamlInt(value);
        if (l != null) return new JsonPrimitive(l);
        Double d = parseYamlFloat(value);
        if (d != null) return new JsonPrimitive(d);
        return new JsonPrimitive(value);
    }

    private static boolean isYamlNull(ScalarNode scalar) {
        Tag tag = scalar.getTag();
        if (Tag.NULL.equals(tag)) return true;
        if (scalar.getValue() == null) return true;
        // Plain (unquoted) null literals only — quoted "null" is a string.
        if (isQuotedScalar(scalar)) return false;
        return isPlainYamlNull(scalar.getValue());
    }

    private static boolean isPlainYamlNull(String raw) {
        return raw.isEmpty() || "~".equals(raw) || "null".equals(raw)
            || "Null".equals(raw) || "NULL".equals(raw);
    }

    /**
     * True if the scalar's style is one of the quoted/block styles (single-quoted,
     * double-quoted, literal {@code |}, or folded {@code >}). SnakeYAML's
     * {@code ScalarStyle.PLAIN.getChar()} returns {@code null}, so callers must guard
     * before invoking {@code charValue()}.
     */
    private static boolean isQuotedScalar(ScalarNode s) {
        org.yaml.snakeyaml.DumperOptions.ScalarStyle style = s.getScalarStyle();
        if (style == null) return false;
        Character ch = style.getChar();
        if (ch == null) return false; // PLAIN
        char c = ch.charValue();
        return c == '\'' || c == '"' || c == '|' || c == '>';
    }

    private static Boolean parseYamlBool(String raw) {
        if ("true".equals(raw) || "True".equals(raw) || "TRUE".equals(raw)) return Boolean.TRUE;
        if ("false".equals(raw) || "False".equals(raw) || "FALSE".equals(raw)) return Boolean.FALSE;
        return null;
    }

    private static Long parseYamlInt(String raw) {
        if (raw.indexOf('.') >= 0 || raw.indexOf('e') >= 0 || raw.indexOf('E') >= 0) return null;
        // Accept the YAML 1.1 carryover SnakeYAML's default resolver still recognizes:
        // hex (0xFF), octal (0o77 / 077), and decimal.
        try {
            String s = raw;
            boolean neg = false;
            if (s.startsWith("+")) s = s.substring(1);
            else if (s.startsWith("-")) { neg = true; s = s.substring(1); }
            long val;
            if (s.startsWith("0x") || s.startsWith("0X")) {
                val = Long.parseLong(s.substring(2), 16);
            } else if (s.startsWith("0o") || s.startsWith("0O")) {
                val = Long.parseLong(s.substring(2), 8);
            } else {
                val = Long.parseLong(s, 10);
            }
            return neg ? -val : val;
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private static Double parseYamlFloat(String raw) {
        if (".inf".equals(raw) || ".Inf".equals(raw) || ".INF".equals(raw))
            return Double.POSITIVE_INFINITY;
        if ("-.inf".equals(raw) || "-.Inf".equals(raw) || "-.INF".equals(raw))
            return Double.NEGATIVE_INFINITY;
        if (".nan".equals(raw) || ".NaN".equals(raw) || ".NAN".equals(raw))
            return Double.NaN;
        if (raw.indexOf('.') < 0 && raw.indexOf('e') < 0 && raw.indexOf('E') < 0) return null;
        try { return Double.valueOf(raw); }
        catch (NumberFormatException ex) { return null; }
    }

    private static String yamlNodeToString(Node node) {
        if (node == null) return "null";
        if (node.getNodeId() == NodeId.scalar) return ((ScalarNode) node).getValue();
        return node.toString();
    }

    // -----------------------------------------------------------------------
    // D2 coercion guard — Node-tree variant.
    //
    // The Object-tree guard above uses raw Java values. For the Node tree we
    // unwrap the scalar value the same way the YAML 1.2 core schema would
    // (so a plain `true` is a boolean, a plain `25` is a number) and call
    // through to the same emitCoercion helper for the message.
    // -----------------------------------------------------------------------

    private static void checkCoercionYaml(String attrName, Node rawNode,
                                          Map<String, ChildRequirement> schemaIndex,
                                          MetaDataRegistry registry,
                                          ParentKey parent,
                                          List<CollectedError> errors, String path) {
        if (schemaIndex == null) return;
        ChildRequirement spec = schemaIndex.get(attrName);
        if (spec == null) return;
        String declared = spec.getExpectedSubType();
        if (declared == null || "*".equals(declared)) return;

        boolean isArrayAttr = isStringArraySubType(declared)
            || isArrayConstraintRegistered(registry, parent, attrName);
        if (isArrayAttr) {
            checkArrayCoercionYaml(attrName, rawNode, declared, errors, path);
            return;
        }

        if (StringAttribute.SUBTYPE_STRING.equals(declared)
            || ClassAttribute.SUBTYPE_CLASS.equals(declared)) {
            if (!isYamlString(rawNode)) {
                emitCoercion(attrName, unwrapForMessage(rawNode), "string", errors, path);
            }
            return;
        }
        if (BooleanAttribute.SUBTYPE_BOOLEAN.equals(declared)) {
            if (!isYamlBoolean(rawNode)) {
                emitCoercion(attrName, unwrapForMessage(rawNode), "boolean", errors, path);
            }
            return;
        }
        if (IntAttribute.SUBTYPE_INT.equals(declared)
            || LongAttribute.SUBTYPE_LONG.equals(declared)
            || DoubleAttribute.SUBTYPE_DOUBLE.equals(declared)) {
            if (!isYamlNumber(rawNode)) {
                emitCoercion(attrName, unwrapForMessage(rawNode), "number", errors, path);
            }
            return;
        }
        // Object-shaped attrs — accept anything.
    }

    private static void checkArrayCoercionYaml(String attrName, Node rawNode,
                                               String declaredElementSubType,
                                               List<CollectedError> errors, String path) {
        if (isYamlString(rawNode)) return; // legitimate one-element shorthand
        if (rawNode == null || rawNode.getNodeId() != NodeId.sequence) {
            String expected = isStringArrayLike(declaredElementSubType)
                ? "string-array (or single string)"
                : declaredElementSubType + "-array (or single " + declaredElementSubType + ")";
            emitCoercion(attrName, unwrapForMessage(rawNode), expected, errors, path);
            return;
        }
        SequenceNode seq = (SequenceNode) rawNode;
        for (int i = 0; i < seq.getValue().size(); i++) {
            Node el = seq.getValue().get(i);
            if (!matchesYamlElementSubType(el, declaredElementSubType)) {
                emitCoercion(attrName + "[" + i + "]", unwrapForMessage(el),
                    elementExpectedLabel(declaredElementSubType), errors, path);
            }
        }
    }

    private static boolean matchesYamlElementSubType(Node el, String elementSubType) {
        if (isStringArrayLike(elementSubType)) return isYamlString(el);
        if (BooleanAttribute.SUBTYPE_BOOLEAN.equals(elementSubType)) return isYamlBoolean(el);
        if (IntAttribute.SUBTYPE_INT.equals(elementSubType)
            || LongAttribute.SUBTYPE_LONG.equals(elementSubType)
            || DoubleAttribute.SUBTYPE_DOUBLE.equals(elementSubType)) {
            return isYamlNumber(el);
        }
        return true;
    }

    private static boolean isYamlString(Node node) {
        if (node == null || node.getNodeId() != NodeId.scalar) return false;
        ScalarNode s = (ScalarNode) node;
        String v = s.getValue();
        if (v == null) return false;
        // Quoted → string.
        if (isQuotedScalar(s)) return true;
        Tag tag = s.getTag();
        if (Tag.STR.equals(tag)) return true;
        // SnakeYAML's resolver may have tagged the plain scalar as int/float/bool/null
        // (e.g. `0xFF` → INT via the YAML 1.1 carryover). Respect that — those are
        // YAML coercions, NOT strings.
        if (Tag.INT.equals(tag) || Tag.FLOAT.equals(tag)
            || Tag.BOOL.equals(tag) || Tag.NULL.equals(tag)) {
            return false;
        }
        // Plain scalar with no specific tag — string only if it doesn't parse as
        // another core type.
        if (isYamlNull(s)) return false;
        if (parseYamlBool(v) != null) return false;
        if (parseYamlInt(v) != null) return false;
        if (parseYamlFloat(v) != null) return false;
        return true;
    }

    private static boolean isYamlBoolean(Node node) {
        if (node == null || node.getNodeId() != NodeId.scalar) return false;
        ScalarNode s = (ScalarNode) node;
        String v = s.getValue();
        if (v == null) return false;
        if (isQuotedScalar(s)) {
            return Tag.BOOL.equals(s.getTag()) && parseYamlBool(v) != null;
        }
        Tag tag = s.getTag();
        if (Tag.BOOL.equals(tag)) return parseYamlBool(v) != null;
        // Plain scalar — implicit resolution: any value that parses as a bool is a bool.
        return parseYamlBool(v) != null;
    }

    private static boolean isYamlNumber(Node node) {
        if (node == null || node.getNodeId() != NodeId.scalar) return false;
        ScalarNode s = (ScalarNode) node;
        String v = s.getValue();
        if (v == null) return false;
        if (isQuotedScalar(s)) {
            Tag t = s.getTag();
            return Tag.INT.equals(t) || Tag.FLOAT.equals(t);
        }
        Tag tag = s.getTag();
        if (Tag.INT.equals(tag)) return parseYamlInt(v) != null;
        if (Tag.FLOAT.equals(tag)) return parseYamlFloat(v) != null;
        // Booleans must not pretend to be numbers (YAML 1.2 core has no overlap).
        if (parseYamlBool(v) != null) return false;
        return parseYamlInt(v) != null || parseYamlFloat(v) != null;
    }

    /**
     * Unwrap a SnakeYAML scalar to a Java value for the "got {0}" portion of the
     * coercion error message. Mirrors the YAML 1.2 core-schema resolution used by
     * the existing Object-tree path.
     */
    private static Object unwrapForMessage(Node node) {
        if (node == null) return null;
        if (node.getNodeId() == NodeId.scalar) {
            ScalarNode s = (ScalarNode) node;
            String v = s.getValue();
            if (v == null) return null;
            if (isQuotedScalar(s)) return v;
            Tag tag = s.getTag();
            if (Tag.STR.equals(tag)) return v;
            if (Tag.NULL.equals(tag)) return null;
            if (Tag.BOOL.equals(tag)) {
                Boolean b = parseYamlBool(v);
                return b != null ? b : v;
            }
            if (Tag.INT.equals(tag)) {
                Long l = parseYamlInt(v);
                return l != null ? l : v;
            }
            if (Tag.FLOAT.equals(tag)) {
                Double d = parseYamlFloat(v);
                return d != null ? d : v;
            }
            // Plain scalars — apply core schema.
            if (isPlainYamlNull(v)) return null;
            Boolean b = parseYamlBool(v);
            if (b != null) return b;
            Long l = parseYamlInt(v);
            if (l != null) return l;
            Double d = parseYamlFloat(v);
            if (d != null) return d;
            return v;
        }
        if (node.getNodeId() == NodeId.sequence) {
            List<Object> list = new ArrayList<>();
            for (Node el : ((SequenceNode) node).getValue()) list.add(unwrapForMessage(el));
            return list;
        }
        if (node.getNodeId() == NodeId.mapping) {
            // Just return the toString as a placeholder; coercion errors over
            // map-shaped values are not produced by the current schema.
            return node.toString();
        }
        return node.toString();
    }
}
