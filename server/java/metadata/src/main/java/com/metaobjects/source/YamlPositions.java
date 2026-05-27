/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import org.yaml.snakeyaml.error.Mark;
import org.yaml.snakeyaml.nodes.MappingNode;
import org.yaml.snakeyaml.nodes.Node;
import org.yaml.snakeyaml.nodes.NodeId;
import org.yaml.snakeyaml.nodes.NodeTuple;
import org.yaml.snakeyaml.nodes.ScalarNode;
import org.yaml.snakeyaml.nodes.SequenceNode;
import org.yaml.snakeyaml.nodes.Tag;

import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * FR5b — YAML authoring source-position carrier (per ADR-0009).
 *
 * <p>Java port of:</p>
 * <ul>
 *   <li>{@code server/typescript/packages/metadata/src/core/yaml-positions.ts}
 *       (carrier + helpers)</li>
 *   <li>{@code server/typescript/packages/metadata/src/core/yaml-positions-walker.ts}
 *       (YAML AST → JSON walker)</li>
 *   <li>{@code server/csharp/MetaObjects/YamlPositions.cs} (C# sibling)</li>
 *   <li>{@code server/python/src/metaobjects/source/yaml_positions.py} (Python sibling)</li>
 * </ul>
 *
 * <h2>Carrier choice — Java-specific</h2>
 *
 * <p>The TS reference uses a Symbol-keyed, non-enumerable property on every wrapper
 * mapping object. The C# port uses a {@code ConditionalWeakTable<JsonObject, PositionMap>}
 * — a GC-tied side table invisible to {@code ToJsonString()}. Python uses a {@code dict}
 * subclass with {@code __slots__} for an attached {@code _yaml_positions} field.</p>
 *
 * <p>Java's {@code com.google.gson.JsonObject} is {@code final}, so the Python approach
 * (subclassing) is unavailable. Instead this port uses an {@link IdentityHashMap}-backed
 * side table threaded explicitly through the desugar — keyed by the {@code JsonObject}
 * reference, carrying a {@link PositionMap} of {@code key → YamlPosition} per mapping.
 * Functionally equivalent to the C#/TS approach: invisible to Gson serialization,
 * dies with the side-table's enclosing scope (no static singleton; no leak), and
 * survives the desugar's Rule-1–5 rewrites by re-attaching to newly-produced
 * {@link JsonObject}s as the pipeline transforms them.</p>
 *
 * <p>The desugar (in {@code YamlDesugar}) builds this table while walking the
 * SnakeYAML {@code Node} tree (which exposes {@code Mark}-based line/col for every
 * scalar key). {@code ParserYaml} then flattens the per-{@code JsonObject} maps into
 * a JSONPath-keyed dictionary the canonical parser can consume by lookup.</p>
 *
 * <p>Per FR5b spec:</p>
 * <ul>
 *   <li>Skip {@code yamlPosition} on desugar-synthesized empty bodies (Rule 3's
 *       empty body has no body-side positions to record);</li>
 *   <li>Inherit on Rule-2's scalar-body {@code name} slot (use the wrapper key's
 *       position);</li>
 *   <li>Preserve on Rule-3's {@code []} strip and Rule-5's {@code @}-prefix rewrite.</li>
 * </ul>
 *
 * @since 7.0.0
 */
public final class YamlPositions {

    private YamlPositions() {
        // Utility class.
    }

    // -----------------------------------------------------------------------
    // PositionMap — per-mapping position-by-key map.
    // -----------------------------------------------------------------------

    /**
     * Position-by-key map attached to one mapping. Keys are body-key strings;
     * values are {@link YamlPosition}s recording where each key appeared in the
     * YAML source.
     */
    public static final class PositionMap {
        private final Map<String, YamlPosition> positions = new LinkedHashMap<>();

        /** Set the position for {@code key}. */
        public void set(String key, YamlPosition pos) {
            positions.put(key, pos);
        }

        /** Get the position for {@code key}, or {@code null} if absent. */
        public YamlPosition get(String key) {
            return positions.get(key);
        }

        /** True when at least one key has a recorded position. */
        public boolean any() {
            return !positions.isEmpty();
        }

        /** Enumerate every (key, position) pair on this map. */
        public Set<Map.Entry<String, YamlPosition>> entries() {
            return positions.entrySet();
        }
    }

    // -----------------------------------------------------------------------
    // SideTable — IdentityHashMap-backed map of JsonObject → PositionMap.
    //
    // C# uses ConditionalWeakTable; Python uses a dict subclass. Java's
    // JsonObject is final, so we thread an explicit identity-keyed side table
    // through the desugar pipeline and flatten in ParserYaml. The table is
    // process-local-equivalent — it lives only as long as the call frame that
    // owns it.
    // -----------------------------------------------------------------------

    /**
     * Mutable identity-keyed side table of position maps. Pass one instance through
     * a desugar run so wrapper objects produced by Rules 1-5 carry their position
     * map across the rewrites.
     */
    public static final class SideTable {
        private final Map<JsonObject, PositionMap> store = new IdentityHashMap<>();

        /** Read the position-by-key map for {@code obj}, or {@code null} if none. */
        public PositionMap getMap(JsonObject obj) {
            if (obj == null) return null;
            return store.get(obj);
        }

        /** Read the position for a specific key on {@code obj}, or {@code null}. */
        public YamlPosition get(JsonObject obj, String key) {
            PositionMap m = getMap(obj);
            return m == null ? null : m.get(key);
        }

        /**
         * Attach (or replace) the position map on {@code obj}. The map lives in this
         * side table only — invisible to Gson's serialization of {@code obj} and to
         * iteration of its properties.
         */
        public void setMap(JsonObject obj, PositionMap positions) {
            Objects.requireNonNull(obj, "obj");
            Objects.requireNonNull(positions, "positions");
            store.put(obj, positions);
        }

        /** True when the table holds no entries. */
        public boolean isEmpty() {
            return store.isEmpty();
        }
    }

    // -----------------------------------------------------------------------
    // Walker — YAML AST → JsonElement, building a fresh side table.
    //
    // Mirrors C#'s YamlPositionWalker.Walk and TS's parseYamlWithPositions:
    // a standalone inspection tool that produces the RAW (non-desugared)
    // JSON shape, with positions attached to every mapping. The production
    // pipeline integrates position-attachment directly into YamlDesugar
    // (single pass over the Node tree). This walker is retained for the
    // walker-tier unit tests in YamlPositionsTest.
    // -----------------------------------------------------------------------

    /** Outcome of walking a YAML node tree: the converted JsonElement plus its side table. */
    public static final class WalkResult {
        public final JsonElement element;
        public final SideTable positions;

        public WalkResult(JsonElement element, SideTable positions) {
            this.element = element;
            this.positions = positions;
        }
    }

    /**
     * Walk a parsed SnakeYAML {@link Node} tree into a Gson {@link JsonElement}
     * (mappings → {@link JsonObject}, sequences → {@link JsonArray}, scalars →
     * {@link JsonPrimitive}/{@link JsonNull}), attaching a {@link PositionMap} to
     * every {@link JsonObject} via a fresh {@link SideTable}.
     *
     * @param node the SnakeYAML node (typically from {@code new Yaml().compose(reader)});
     *             {@code null} yields {@code JsonNull.INSTANCE} with an empty side table
     * @return the converted element + the side table populated during the walk
     */
    public static WalkResult walk(Node node) {
        SideTable table = new SideTable();
        JsonElement el = walkInto(node, table);
        return new WalkResult(el, table);
    }

    /** Recursive walker that mutates the supplied side table. */
    private static JsonElement walkInto(Node node, SideTable table) {
        if (node == null) return JsonNull.INSTANCE;
        if (node.getNodeId() == NodeId.scalar) {
            return scalarToJsonElement((ScalarNode) node);
        }
        if (node.getNodeId() == NodeId.sequence) {
            SequenceNode seq = (SequenceNode) node;
            JsonArray arr = new JsonArray();
            for (Node child : seq.getValue()) {
                arr.add(walkInto(child, table));
            }
            return arr;
        }
        if (node.getNodeId() == NodeId.mapping) {
            MappingNode map = (MappingNode) node;
            JsonObject obj = new JsonObject();
            PositionMap positions = null;
            for (NodeTuple tuple : map.getValue()) {
                Node keyNode = tuple.getKeyNode();
                if (keyNode.getNodeId() != NodeId.scalar) {
                    // Non-scalar keys: not allowed in the metaobjects grammar;
                    // skip silently here — YamlDesugar reports the structural error.
                    continue;
                }
                ScalarNode keyScalar = (ScalarNode) keyNode;
                String keyText = keyScalar.getValue();
                if (keyText == null) continue;
                obj.add(keyText, walkInto(tuple.getValueNode(), table));

                YamlPosition pos = positionOf(keyScalar);
                if (pos != null) {
                    if (positions == null) positions = new PositionMap();
                    positions.set(keyText, pos);
                }
            }
            if (positions != null && positions.any()) {
                table.setMap(obj, positions);
            }
            return obj;
        }
        // Aliases/anchors — the authoring grammar doesn't use them; emit JsonNull.
        return JsonNull.INSTANCE;
    }

    // -----------------------------------------------------------------------
    // SnakeYAML mark → YamlPosition.
    //
    // SnakeYAML's Mark uses 0-indexed line/column; we normalize to 1-based
    // (matching TS / C# / Python and most editors).
    // -----------------------------------------------------------------------

    /**
     * Extract a 1-based {@link YamlPosition} from a SnakeYAML node's start mark.
     * Returns {@code null} when no usable mark is available.
     */
    public static YamlPosition positionOf(Node n) {
        if (n == null) return null;
        Mark m = n.getStartMark();
        if (m == null) return null;
        // SnakeYAML marks are 0-indexed; YAML editors are 1-indexed.
        return new YamlPosition(m.getLine() + 1, m.getColumn() + 1);
    }

    // -----------------------------------------------------------------------
    // Scalar → JsonElement (matches YAML 1.2 core schema; duplicates the
    // scalar-typing logic from YamlDesugar so the walker is self-contained).
    // -----------------------------------------------------------------------

    private static JsonElement scalarToJsonElement(ScalarNode scalar) {
        String value = scalar.getValue();
        Tag tag = scalar.getTag();

        if (value == null) return JsonNull.INSTANCE;
        if (Tag.NULL.equals(tag)) return JsonNull.INSTANCE;

        // Quoted scalars → strings. SnakeYAML's PLAIN style returns a null Character
        // from getChar(); guard before invoking charValue().
        if (isQuotedScalar(scalar)) {
            return new JsonPrimitive(value);
        }

        if (Tag.STR.equals(tag)) return new JsonPrimitive(value);
        if (Tag.BOOL.equals(tag)) {
            Boolean b = parseBool(value);
            return b != null ? new JsonPrimitive(b) : new JsonPrimitive(value);
        }
        if (Tag.INT.equals(tag)) {
            Long l = parseInt(value);
            return l != null ? new JsonPrimitive(l) : new JsonPrimitive(value);
        }
        if (Tag.FLOAT.equals(tag)) {
            Double d = parseFloat(value);
            return d != null ? new JsonPrimitive(d) : new JsonPrimitive(value);
        }

        // Plain scalars — YAML 1.2 core: null/bool first, then int, then float, fallback string.
        if (isPlainNull(value)) return JsonNull.INSTANCE;
        Boolean b = parseBool(value);
        if (b != null) return new JsonPrimitive(b);
        Long l = parseInt(value);
        if (l != null) return new JsonPrimitive(l);
        Double d = parseFloat(value);
        if (d != null) return new JsonPrimitive(d);
        return new JsonPrimitive(value);
    }

    private static boolean isPlainNull(String raw) {
        return raw.isEmpty() || "~".equals(raw) || "null".equals(raw)
            || "Null".equals(raw) || "NULL".equals(raw);
    }

    /**
     * True if the scalar's style is one of the quoted/block styles. SnakeYAML's
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

    private static Boolean parseBool(String raw) {
        if ("true".equals(raw) || "True".equals(raw) || "TRUE".equals(raw)) return Boolean.TRUE;
        if ("false".equals(raw) || "False".equals(raw) || "FALSE".equals(raw)) return Boolean.FALSE;
        return null;
    }

    private static Long parseInt(String raw) {
        // Reject anything that looks float-y; decimal long only.
        if (raw.indexOf('.') >= 0 || raw.indexOf('e') >= 0 || raw.indexOf('E') >= 0) return null;
        try {
            return Long.valueOf(raw);
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private static Double parseFloat(String raw) {
        if (".inf".equals(raw) || ".Inf".equals(raw) || ".INF".equals(raw)) {
            return Double.POSITIVE_INFINITY;
        }
        if ("-.inf".equals(raw) || "-.Inf".equals(raw) || "-.INF".equals(raw)) {
            return Double.NEGATIVE_INFINITY;
        }
        if (".nan".equals(raw) || ".NaN".equals(raw) || ".NAN".equals(raw)) {
            return Double.NaN;
        }
        // Only accept float when it actually looks float-y (has '.' or exponent).
        if (raw.indexOf('.') < 0 && raw.indexOf('e') < 0 && raw.indexOf('E') < 0) return null;
        try {
            return Double.valueOf(raw);
        } catch (NumberFormatException ex) {
            return null;
        }
    }
}
