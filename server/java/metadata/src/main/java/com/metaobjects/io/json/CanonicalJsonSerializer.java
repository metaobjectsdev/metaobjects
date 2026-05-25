package com.metaobjects.io.json;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.metaobjects.DataTypes;
import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.parser.BaseMetaDataParser;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * Canonical JSON serializer for MetaData trees.
 *
 * <p>Produces the canonical format used across all language implementations
 * (TypeScript, Java, Python, C#). Every node serializes to a single-key JSON
 * object {@code { "<type>.<subType>": <body> }}. Body keys are emitted in the
 * canonical order: {@code name}, {@code package}, {@code extends},
 * {@code abstract}, {@code isArray}, then {@code @}-prefixed attributes in
 * alphabetical order, then {@code children}.</p>
 *
 * <p>Design principles:</p>
 * <ul>
 *   <li><strong>100% registry-driven</strong> — no hardcoded type or subtype names.
 *       New types contributed by providers serialize with zero edits here.</li>
 *   <li>Only the fixed framework reserved keys ({@code name}, {@code package},
 *       {@code extends}, {@code abstract}, {@code isArray}, {@code children},
 *       {@code value}, {@code overlay}) and the special attribute names
 *       ({@code isAbstract}, {@code isArray}) are named in this class.</li>
 *   <li>Mirrors the TypeScript {@code canonicalSerialize} / {@code canonicalSerializeEffective}
 *       in {@code serializer-json.ts}.</li>
 * </ul>
 *
 * @see <a href="https://github.com/metaobjectsdev/metaobjects">MetaObjects</a>
 */
public final class CanonicalJsonSerializer {

    // ---------------------------------------------------------------------------
    // Framework reserved body keys — the ONLY metamodel strings this class names.
    // ---------------------------------------------------------------------------

    /** Body key: short name of the node. */
    private static final String KEY_NAME = "name";

    /** Body key: package in which the node is introduced. */
    private static final String KEY_PACKAGE = "package";

    /** Body key: name of the super (extends) node. */
    private static final String KEY_EXTENDS = "extends";

    /**
     * Body key for the abstract flag.
     * Note: the attribute itself is named "isAbstract" (MetaData.ATTR_IS_ABSTRACT),
     * but the canonical body key is "abstract".
     */
    private static final String KEY_ABSTRACT = "abstract";

    /**
     * Body key for the isArray flag.
     * Also the name of the native property on MetaField / MetaAttribute —
     * so both the key and the attr-name constants resolve to the same string.
     */
    private static final String KEY_IS_ARRAY = "isArray";

    /** Body key for the children list. */
    private static final String KEY_CHILDREN = "children";

    /** Separator between type and subType in the fused node key. */
    private static final String TYPE_SUBTYPE_SEPARATOR = ".";

    /**
     * Shared Gson instance for OBJECT-datatype attribute serialization.
     * Used only in {@link #attrValueToJson} to convert Map values to JsonElement.
     * Plain Gson (no pretty-printing) — pretty-printing is applied by
     * {@link #toCanonicalString} over the full tree, not per-attribute.
     */
    private static final Gson GSON = new Gson();

    /** Prefix for inline @-attributes. */
    private static final String ATTR_PREFIX = "@";

    // ---------------------------------------------------------------------------
    // Special attribute names that map to reserved body keys (not @-attrs).
    // ---------------------------------------------------------------------------

    /**
     * MetaAttribute name for the abstract marker.
     * Equals {@link MetaData#ATTR_IS_ABSTRACT}; declared here for clarity.
     */
    private static final String ATTR_NAME_IS_ABSTRACT = MetaData.ATTR_IS_ABSTRACT; // "isAbstract"

    /**
     * MetaAttribute/MetaField native property name for the array marker.
     * Equals {@link MetaField#ATTR_IS_ARRAY}.
     */
    private static final String ATTR_NAME_IS_ARRAY = MetaField.ATTR_IS_ARRAY; // "isArray"

    // Private constructor — utility class.
    private CanonicalJsonSerializer() {}

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /**
     * Serializes the OWN declared structure of {@code node} (own children and
     * own attributes, not the super-chain-merged view) to canonical JSON.
     *
     * <p>Output: 2-space indent, exactly one trailing newline.</p>
     *
     * @param node the root of the tree to serialize
     * @return canonical JSON string
     */
    public static String canonicalSerialize(MetaData node) {
        JsonElement tree = serializeNode(node, /*effective=*/false, /*parentPackage=*/null);
        return toCanonicalString(tree);
    }

    /**
     * Serializes the EFFECTIVE (super-chain-merged) structure of {@code node}
     * to canonical JSON. Each node exposes the merged view of its own children
     * and attrs plus those inherited from its super chain.
     *
     * <p>Output: 2-space indent, exactly one trailing newline.</p>
     *
     * @param node the root of the tree to serialize
     * @return canonical JSON string
     */
    public static String canonicalSerializeEffective(MetaData node) {
        JsonElement tree = serializeNode(node, /*effective=*/true, /*parentPackage=*/null);
        return toCanonicalString(tree);
    }

    // ---------------------------------------------------------------------------
    // Core serialization
    // ---------------------------------------------------------------------------

    /**
     * Serializes a single node to {@code { "<type>.<subType>": <body> }}.
     *
     * @param node          the node to serialize
     * @param effective     true = use inherited children + attrs (effective view);
     *                      false = use own children + attrs only
     * @param parentPackage the package emitted by the parent node, or {@code null}
     *                      if there is no parent (i.e. this is the tree root).
     *                      Used to suppress redundant {@code package} keys.
     */
    private static JsonElement serializeNode(MetaData node, boolean effective, String parentPackage) {
        String fusedKey = node.getType() + TYPE_SUBTYPE_SEPARATOR + node.getSubType();
        JsonObject body = serializeBody(node, effective, parentPackage);

        JsonObject wrapper = new JsonObject();
        wrapper.add(fusedKey, body);
        return wrapper;
    }

    /**
     * Builds the body object for a node.
     *
     * <p>Key emission order (canonical):</p>
     * <ol>
     *   <li>{@code name}     — short name, only when authored (skip empty / auto-generated)</li>
     *   <li>{@code package}  — only when introduced here (differs from parent package)</li>
     *   <li>{@code extends}  — only when super data exists</li>
     *   <li>{@code abstract} — only when true (sourced from isAbstract MetaAttribute)</li>
     *   <li>{@code isArray}  — only when true (sourced from native property on MetaField/MetaAttribute)</li>
     *   <li>{@code @}-attrs  — inline attributes, alphabetical, excluding isAbstract/isArray</li>
     *   <li>{@code children} — structural child nodes (recursive); non-empty only</li>
     * </ol>
     */
    private static JsonObject serializeBody(MetaData node, boolean effective, String parentPackage) {
        JsonObject body = new JsonObject();

        // 1. name — omit empty names, auto-generated names, and root-node names.
        //
        // For MetaRoot, the full name (e.g. "acme::commerce") is the package identifier,
        // not an authored node name. The short name ("commerce") must not be emitted.
        String shortName = node.getShortName();
        if (shortName != null && !shortName.isEmpty()
                && !(node instanceof MetaRoot)
                && !isAutoGeneratedName(node)) {
            body.addProperty(KEY_NAME, shortName);
        }

        // 2. package — emit only where introduced (differs from parent's package).
        //
        // Special case: MetaRoot's full name IS the package (e.g. "acme::commerce").
        // For all other nodes, getPackage() gives the package prefix of the qualified name.
        //
        // WHY "differs from parent" rather than a naive "emit if non-empty":
        // The TS oracle uses model.package, which is the *authored* package — undefined
        // when the author did not write a package key, so "emit if present" works there.
        // Java's getPackage() returns the *effective* (inherited) package: every node in
        // an "acme::commerce" tree would return "acme::commerce" even when they never
        // authored it. Emitting unconditionally would wrongly inject a "package" key on
        // every node. Emitting only when the value differs from the parent's resolved
        // package approximates "authored here for the first time."
        //
        // Known imprecision (Task 2 follow-up): a child that redundantly re-authors the
        // exact same package as its parent would be suppressed here but emitted by TS.
        // Tracking the truly-authored package requires a separate flag on MetaData that
        // does not exist yet; that is the Task 2 work.
        String nodePackage = resolveNodePackage(node);
        if (nodePackage != null && !nodePackage.isEmpty()) {
            boolean differsFromParent = (parentPackage == null) || !nodePackage.equals(parentPackage);
            // Cross-port: shared-type nodes at root (e.g. an abstract field.enum
            // declared at metadata.root) always emit their package, even when it
            // equals the root's package — they are addressable "library" entries
            // that need a stable qualifier. Objects naturally live at root and
            // do not need the redundant emission.
            boolean rootSharedType = (node.getParent() instanceof MetaRoot)
                && !(node instanceof com.metaobjects.object.MetaObject);
            if (differsFromParent || rootSharedType) {
                body.addProperty(KEY_PACKAGE, nodePackage);
            }
        }

        // 3. extends — emit when super data is set
        // Use the short name when the super is in the same package as the node;
        // use the fully-qualified name when the super lives in a different package
        // so that round-trip loading can resolve it correctly.
        if (node.hasSuperData()) {
            MetaData superData = node.getSuperData();
            // For "same-package" detection we want the NODE's AUTHORING context
            // (closest MetaObject/MetaRoot ancestor's package — a field `status`
            // inside `Order` in `acme` has getPackage() == "acme::Order" but
            // authors think of it as living in "acme") compared against the
            // SUPER's own declared package (from its FQN), so synthetic
            // tree-misalignments still emit FQN extends when the names diverge.
            String authoringPackage = authoringPackageFor(node);
            String superPackage = resolveNodePackage(superData);
            String superRef;
            if (authoringPackage != null && !authoringPackage.isEmpty()
                    && authoringPackage.equals(superPackage)) {
                superRef = superData.getShortName();
            } else {
                superRef = superData.getName();
            }
            if (superRef != null && !superRef.isEmpty()) {
                body.addProperty(KEY_EXTENDS, superRef);
            }
        }

        // 4. abstract — sourced from "isAbstract" MetaAttribute child
        boolean isAbstractValue = getIsAbstractValue(node);
        if (isAbstractValue) {
            body.addProperty(KEY_ABSTRACT, true);
        }

        // 5. isArray — sourced from native property on MetaField / MetaAttribute
        boolean isArrayValue = getNativeIsArray(node);
        if (isArrayValue) {
            body.addProperty(KEY_IS_ARRAY, true);
        }

        // 6. @-attrs (alphabetical, excluding isAbstract / isArray reserved ones)
        //    and 7. children — collect both, then emit attrs first, then children.
        //
        // Strategy: walk children list.
        //   - MetaAttribute children become inline @-attrs (excluded: isAbstract, isArray).
        //   - Non-MetaAttribute children become structural child nodes.
        //
        // In effective mode, getMetaAttrs(false) + getChildren(MetaData, false) would give
        // own-only; for effective we use getMetaAttrs(true) for inherited attrs, but structural
        // children via getChildren(MetaData.class, true) includes inherited structural children.

        List<MetaData> structuralChildren;
        List<MetaAttribute> attrChildren;

        if (effective) {
            // Effective: own + inherited via super chain
            structuralChildren = collectEffectiveStructuralChildren(node);
            attrChildren = node.getMetaAttrs(true); // true = include parent
        } else {
            // Own only: only direct children declared on this node
            structuralChildren = collectOwnStructuralChildren(node);
            attrChildren = node.getMetaAttrs(false); // false = own only
        }

        // Build sorted @-attr map, skipping reserved attr names
        TreeMap<String, JsonElement> sortedAttrs = new TreeMap<>();
        for (MetaAttribute attr : attrChildren) {
            String attrName = attr.getName();
            // Skip attrs that map to reserved body keys
            if (ATTR_NAME_IS_ABSTRACT.equals(attrName) || ATTR_NAME_IS_ARRAY.equals(attrName)) {
                continue;
            }
            JsonElement attrValue = attrValueToJson(attr);
            sortedAttrs.put(ATTR_PREFIX + attrName, attrValue);
        }
        for (Map.Entry<String, JsonElement> e : sortedAttrs.entrySet()) {
            body.add(e.getKey(), e.getValue());
        }

        // Serialize structural children (recursive).
        // Children inherit the current node's resolved package as their "parent package".
        // For root nodes the full name is the package; for all others use getPackage().
        String childParentPackage = (nodePackage != null && !nodePackage.isEmpty()) ? nodePackage : parentPackage;
        if (!structuralChildren.isEmpty()) {
            JsonArray childArray = new JsonArray();
            for (MetaData child : structuralChildren) {
                childArray.add(serializeNode(child, effective, childParentPackage));
            }
            body.add(KEY_CHILDREN, childArray);
        }

        return body;
    }

    // ---------------------------------------------------------------------------
    // Helpers — children collection
    // ---------------------------------------------------------------------------

    /**
     * Returns the own non-attribute children of {@code node} in declaration order.
     * Excludes {@link MetaAttribute} instances (those become inline @-attrs).
     */
    private static List<MetaData> collectOwnStructuralChildren(MetaData node) {
        List<MetaData> result = new ArrayList<>();
        for (MetaData child : node.getChildren()) {
            if (!(child instanceof MetaAttribute)) {
                result.add(child);
            }
        }
        return result;
    }

    /**
     * Returns structural children (own + inherited from super chain) de-duplicated by
     * type+name, preserving own children first.
     */
    private static List<MetaData> collectEffectiveStructuralChildren(MetaData node) {
        // getChildren(MetaData.class, true) walks the super chain but de-duplicates by type-name key.
        List<MetaData> all = node.getChildren(MetaData.class, true);
        List<MetaData> result = new ArrayList<>();
        for (MetaData child : all) {
            if (!(child instanceof MetaAttribute)) {
                result.add(child);
            }
        }
        return result;
    }

    // ---------------------------------------------------------------------------
    // Helpers — package resolution
    // ---------------------------------------------------------------------------

    /**
     * Returns the "canonical package" for a node.
     *
     * <p>For {@link MetaRoot}, the node's full {@link MetaData#getName()} IS the
     * package (e.g. {@code "acme::commerce"}). The default {@link MetaData#getPackage()}
     * would split on the last {@code ::} and return only the first segment
     * ({@code "acme"}), which is wrong for root nodes.</p>
     *
     * <p>For all other nodes the package is the prefix before the last {@code ::}
     * in the fully-qualified name, i.e. {@link MetaData#getPackage()} is correct.</p>
     */
    /**
     * Returns the "authoring package" of a node — the package context an author
     * would use to write its {@code extends} ref. For root-level nodes this is
     * the root's own package; for child nodes it walks up to the nearest
     * MetaObject (entity / value) and returns that ancestor's package. Used by
     * extends-ref serialization so a field inside an entity in package X
     * references a sibling in X by short name (not by FQN).
     */
    private static String authoringPackageFor(MetaData node) {
        MetaData current = node;
        while (current != null) {
            if (current instanceof MetaRoot) {
                return resolveNodePackage(current);
            }
            // If we hit a non-root parent that isn't a MetaObject, keep walking
            // up — the goal is the nearest containing entity OR the root.
            MetaData parent = current.getParent();
            if (parent == null) break;
            if (parent instanceof MetaRoot) {
                // current's authoring context = root's package
                return resolveNodePackage(parent);
            }
            if (parent instanceof com.metaobjects.object.MetaObject) {
                // current is a child of an entity → authoring context = entity's package
                return parent.getPackage();
            }
            current = parent;
        }
        return node.getPackage();
    }

    private static String resolveNodePackage(MetaData node) {
        if (node instanceof MetaRoot) {
            // The root's name is the package itself — unless the loader had no
            // authored name to bind it to, in which case the canonical wire
            // form is "no package" (TS/C#/Python parity).
            if (((MetaRoot) node).hasSynthesizedName()) {
                return null;
            }
            return node.getName();
        }
        return node.getPackage();
    }

    // ---------------------------------------------------------------------------
    // Helpers — isAbstract / isArray
    // ---------------------------------------------------------------------------

    /**
     * Returns {@code true} if this node has an {@code isAbstract} MetaAttribute child
     * whose value is {@code Boolean.TRUE}.
     *
     * <p>The {@code hasMetaAttr} guard above guarantees the attribute exists before
     * {@code getMetaAttr} is called, so no checked exception is expected here.
     * {@code getMetaAttr} declares {@link com.metaobjects.MetaDataException} (unchecked);
     * we allow it to propagate so unexpected failures surface as test/runtime errors
     * rather than being silently swallowed.</p>
     */
    private static boolean getIsAbstractValue(MetaData node) {
        if (!node.hasMetaAttr(ATTR_NAME_IS_ABSTRACT, false)) {
            return false;
        }
        MetaAttribute attr = node.getMetaAttr(ATTR_NAME_IS_ABSTRACT, false);
        Object val = attr.getValue();
        return Boolean.TRUE.equals(val);
    }

    /**
     * Returns the native {@code isArray} value from {@link MetaField} or
     * {@link MetaAttribute}. Returns {@code false} for all other MetaData types.
     */
    private static boolean getNativeIsArray(MetaData node) {
        if (node instanceof MetaField) {
            return ((MetaField<?>) node).isArray();
        }
        if (node instanceof MetaAttribute) {
            return ((MetaAttribute<?>) node).isArray();
        }
        return false;
    }

    // ---------------------------------------------------------------------------
    // Helpers — auto-generated name detection
    // ---------------------------------------------------------------------------

    /**
     * Returns {@code true} if the node's short name was auto-generated by the parser.
     *
     * <p>Auto-naming applies only to {@code validator} and {@code view} type nodes.
     * {@link com.metaobjects.loader.parser.BaseMetaDataParser} generates names of the
     * exact form {@code <prefix><N>} where {@code prefix} is the node's subType
     * lowercased (or the type lowercased when there is no subType), and {@code N} is
     * a positive integer. Detection therefore uses the <em>exact</em> expected prefix
     * derived from this node's own type/subType — not a blanket pattern.</p>
     *
     * <p>This prevents silently dropping an explicitly authored name that happens to
     * end in a digit (e.g. a validator named {@code length2} whose subType is
     * {@code regex} would only be auto-detected as {@code regex\d+}, so {@code length2}
     * is correctly treated as authored).</p>
     *
     * <p>All other type nodes require explicit names; if the short name is present
     * it was authored and must be emitted.</p>
     */
    private static boolean isAutoGeneratedName(MetaData node) {
        String typeName = node.getType();
        // Only the types in isAutoNamingType (validator, view, source, identity) use
        // auto-naming — delegate to the single source of truth.
        if (!BaseMetaDataParser.isAutoNamingType(typeName)) {
            return false;
        }
        String shortName = node.getShortName();
        if (shortName == null || shortName.isEmpty()) {
            return true; // empty = auto (degenerate case)
        }
        // Derive the exact prefix the parser would have used:
        //   subType lowercased if non-null/non-empty, otherwise type lowercased.
        String subType = node.getSubType();
        String expectedPrefix = (subType != null && !subType.isEmpty())
                ? subType.toLowerCase()
                : typeName.toLowerCase();
        // Auto-generated name matches EXACTLY <expectedPrefix><digits>.
        // Using Pattern.quote so any regex-special chars in the prefix are treated literally.
        return shortName.matches("^" + Pattern.quote(expectedPrefix) + "\\d+$");
    }

    // ---------------------------------------------------------------------------
    // Helpers — attribute value → JsonElement
    // ---------------------------------------------------------------------------

    /**
     * Converts a MetaAttribute's value to a JsonElement for inline emission.
     *
     * <p>Special handling:</p>
     * <ul>
     *   <li>A {@link com.metaobjects.attr.StringAttribute} with {@code isArray=true}
     *       serializes its single value as a one-element JSON array.</li>
     *   <li>A {@link com.metaobjects.attr.StringArrayAttribute} (whose value is a
     *       {@code List<String>}) serializes as a JSON array.</li>
     *   <li>OBJECT-datatype attrs (e.g. {@code attr.filter}) whose value is a
     *       {@link java.util.Map} serialize as a JSON object via {@code Gson.toJsonTree}.
     *       This covers nested Maps and List values inside the map (e.g. the
     *       {@code {in: [...]} } form produced by {@code FilterAttribute} desugar).
     *       {@link com.metaobjects.attr.PropertiesAttribute} is NOT affected — it
     *       declares {@link com.metaobjects.DataTypes#CUSTOM}, not OBJECT, and does
     *       not reach this branch.</li>
     *   <li>Boolean, int/long, double values map to their JSON primitive types.</li>
     *   <li>Everything else serializes as a JSON string.</li>
     * </ul>
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private static JsonElement attrValueToJson(MetaAttribute attr) {
        Object value = attr.getValue();

        // OBJECT-datatype attr with a Map value: emit as a JSON object.
        // Guard: DataTypes.OBJECT ensures only attrs that explicitly declare object
        // semantics (e.g. FilterAttribute) take this path. Gson.toJsonTree handles
        // nested Maps/Lists/primitives natively, so the full desugared filter
        // structure ({field: {op: value}, ...}) round-trips correctly.
        if (attr.getDataType() == DataTypes.OBJECT && value instanceof Map) {
            return GSON.toJsonTree(value);
        }

        // PropertiesAttribute (DataTypes.CUSTOM, value is java.util.Properties):
        // emit as a JSON object with string-valued keys. Cross-port: TS/C# both
        // serialize attr.properties as `@<name>: { key: value, ... }`.
        if (value instanceof java.util.Properties) {
            java.util.Properties props = (java.util.Properties) value;
            JsonObject obj = new JsonObject();
            java.util.TreeMap<String, String> sorted = new java.util.TreeMap<>();
            for (String name : props.stringPropertyNames()) {
                sorted.put(name, props.getProperty(name));
            }
            for (Map.Entry<String, String> e : sorted.entrySet()) {
                obj.addProperty(e.getKey(), e.getValue());
            }
            return obj;
        }

        // StringArrayAttribute: value is List<String>
        if (value instanceof List) {
            List<String> list = (List<String>) value;
            JsonArray arr = new JsonArray();
            for (String s : list) {
                arr.add(s);
            }
            return arr;
        }

        // StringAttribute (or any attr) with isArray=true: wrap single value in array.
        if (attr.isArray()) {
            JsonArray arr = new JsonArray();
            if (value != null) {
                arr.add(primitiveToJson(value));
            }
            return arr;
        }

        if (value == null) {
            return new JsonPrimitive(""); // emit empty string for missing values
        }

        return primitiveToJson(value);
    }

    /** Converts a non-null primitive-ish value to a JsonPrimitive. */
    private static JsonElement primitiveToJson(Object value) {
        if (value instanceof Boolean) {
            return new JsonPrimitive((Boolean) value);
        }
        if (value instanceof Number) {
            return new JsonPrimitive((Number) value);
        }
        return new JsonPrimitive(value.toString());
    }

    // ---------------------------------------------------------------------------
    // Output formatting
    // ---------------------------------------------------------------------------

    /**
     * Renders the JsonElement to a canonical string:
     * 2-space indent, no HTML escaping, exactly one trailing newline.
     *
     * <p>Gson's pretty-printer uses 2-space indentation and produces output that
     * matches the TypeScript {@code JSON.stringify(sorted, null, 2)} format.</p>
     */
    private static String toCanonicalString(JsonElement element) {
        String raw = new GsonBuilder()
                .setPrettyPrinting()
                .disableHtmlEscaping()
                .create()
                .toJson(element);
        // Ensure exactly one trailing newline.
        return raw.stripTrailing() + "\n";
    }
}
