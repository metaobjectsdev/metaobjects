/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
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

    private YamlDesugar() {
        // Utility class.
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

        public DesugarResult(JsonObject canonical, List<CollectedError> errors) {
            this.canonical = canonical;
            this.errors = errors;
        }
    }

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    /**
     * Desugar a parsed-YAML authoring document into a canonical-shaped {@link JsonObject}.
     *
     * @param input    the raw SnakeYAML-parsed object (typically a {@link Map}); never thrown on
     * @param registry the type registry used for default-subType resolution + coercion checks
     * @return the canonical JSON object and any collected diagnostics
     */
    public static DesugarResult desugar(Object input, MetaDataRegistry registry) {
        List<CollectedError> errors = new ArrayList<>();
        JsonObject node = desugarNode(input, registry, errors, "<root>");
        JsonObject canonical = node != null ? node : new JsonObject();
        return new DesugarResult(canonical, errors);
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
                                          List<CollectedError> errors, String path) {
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

        // Rule 2: a scalar body → { name: <scalar> }.
        JsonObject body = desugarBody(rawBody, registry, canonicalKey, errors, path);

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
                JsonObject child = desugarNode(list.get(i), registry, errors, childPath);
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
                                          List<CollectedError> errors, String path) {
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
                out.add(key, toJsonElement(value));
                // D2 also applies to author-written @-keys (the awkward form).
                if (key.startsWith(ATTR_PREFIX)) {
                    String attrName = key.substring(ATTR_PREFIX.length());
                    if (!attrName.isEmpty() && !RESERVED_KEYS.contains(attrName)) {
                        checkCoercion(attrName, value, attrSchemaIndex, registry, parent,
                            errors, path);
                    }
                }
            } else {
                out.add(ATTR_PREFIX + key, toJsonElement(value));
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
}
