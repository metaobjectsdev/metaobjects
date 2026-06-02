/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.registry;

import com.metaobjects.MetaDataTypeId;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.field.MetaField;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * SP-G Registry Conformance — the Java registry-manifest emitter.
 *
 * <p>Walks a {@link MetaDataRegistry} and serializes the LOGICAL metamodel
 * vocabulary as a canonical, fully-sorted, byte-stable JSON manifest. This must
 * byte-match the single committed canonical produced by the TS reference
 * emitter ({@code server/typescript/packages/metadata/src/registry-manifest.ts})
 * — a structural gate against the SP-C class of silent vocabulary drift (a
 * port's registry diverging — wrong attr names, missing subtypes, different
 * required-ness — with every behavioral corpus still green).</p>
 *
 * <p>The IN/OUT boundary (the v1 logical subset emittable byte-identically by
 * all five ports) is documented in {@code fixtures/registry-conformance/README.md}.
 * In short: {@code type.subType} + {@code attrs[{name, valueType, required}]} +
 * {@code commonAttrs} + {@code defaultSubTypes}.</p>
 *
 * <p><strong>The Java porting subtlety.</strong> Java models an attribute as a
 * {@link ChildRequirement} ({@code expectedType == "attr"}) on a
 * {@link TypeDefinition}, alongside child-type rules (a {@code ChildRequirement}
 * with {@code name == "*"}) and placement/validation-constraint variants. The
 * v1 manifest emits ONLY the attribute child-requirements — it filters to
 * {@code expectedType == "attr"} and a non-wildcard name. The non-attr / wildcard
 * requirements are the deferred {@code childRules} and never leak into the
 * manifest (see README "EXCLUDED from v1").</p>
 *
 * <p>EXCLUDED from v1 (per-port-physical or not-universally-tracked-on-the-
 * registry): factories / {@code Class} bindings; declared parent
 * ({@code inheritsFrom}); {@code allowedValues} / per-attr default;
 * {@code childRules}.</p>
 */
public final class RegistryManifest {

    private RegistryManifest() {
        // Utility class — no instantiation.
    }

    /**
     * The polymorphic / untyped attr whose value-type follows its owning field's
     * subtype. The manifest renders its {@code valueType} as an explicit
     * {@code null} literal (mirrors the TS reference, where {@code @default} has
     * no fixed value-type).
     */
    private static final String POLYMORPHIC_DEFAULT_ATTR = MetaField.ATTR_DEFAULT;

    /** Wildcard token used by Java's {@link ChildRequirement} for "any name / any type". */
    private static final String WILDCARD = "*";

    /** One attribute in the manifest — the logical, cross-port-identical facet. */
    private record ManifestAttr(String name, String valueType, boolean required) {}

    /** One registered (type, subType) with its declared attrs. */
    private record ManifestType(String type, String subType, List<ManifestAttr> attrs) {}

    // ------------------------------------------------------------------
    // Build
    // ------------------------------------------------------------------

    /**
     * Collect the attr child-requirements declared on one (type, subType) and
     * normalize them to the manifest's logical attr shape, sorted by name.
     *
     * <p>Only {@code expectedType == "attr"}, non-wildcard-name requirements are
     * kept (the attr facet). Wildcard child rules and non-attr child rules are
     * the deferred {@code childRules} and are dropped. De-duped by name (a direct
     * requirement overriding an inherited one with the same name is collapsed —
     * the cross-port manifest has exactly one entry per attr name).</p>
     */
    private static List<ManifestAttr> attrsOf(MetaDataRegistry registry, String type, String subType) {
        TypeDefinition def = registry.getTypeDefinition(type, subType);
        if (def == null) {
            return List.of();
        }

        // De-dupe by attr name; required-ness "true wins" if any requirement for
        // the same name is required (matches the logical intent — an attr is
        // required if the type requires it).
        Map<String, ManifestAttr> byName = new LinkedHashMap<>();
        for (ChildRequirement req : def.getChildRequirements()) {
            if (!MetaAttribute.TYPE_ATTR.equals(req.getExpectedType())) {
                continue; // non-attr child rule (deferred childRules)
            }
            String name = req.getName();
            if (name == null || WILDCARD.equals(name)) {
                continue; // wildcard "any attr" rule (deferred childRules)
            }
            String valueType = valueTypeOf(name, req.getExpectedSubType());
            ManifestAttr existing = byName.get(name);
            boolean required = req.isRequired() || (existing != null && existing.required());
            byName.put(name, new ManifestAttr(name, valueType, required));
        }

        List<ManifestAttr> attrs = new ArrayList<>(byName.values());
        attrs.sort(Comparator.comparing(ManifestAttr::name));
        return attrs;
    }

    /**
     * Map a Java attr requirement to the cross-port manifest value-type vocabulary.
     * The polymorphic {@code @default} attr is rendered as {@code null}; every
     * other attr carries its {@code expectedSubType} verbatim (the attr subtype
     * names — {@code string}, {@code int}, {@code boolean}, {@code long},
     * {@code double}, {@code stringarray}, {@code properties}, {@code filter} —
     * are already the cross-port value-type vocabulary). A wildcard subtype is
     * rendered as {@code null} (untyped).
     */
    private static String valueTypeOf(String attrName, String expectedSubType) {
        if (POLYMORPHIC_DEFAULT_ATTR.equals(attrName)) {
            return null;
        }
        if (expectedSubType == null || WILDCARD.equals(expectedSubType)) {
            return null;
        }
        return expectedSubType;
    }

    // ------------------------------------------------------------------
    // Emit
    // ------------------------------------------------------------------

    /**
     * Emit the canonical registry manifest as a byte-stable JSON string.
     *
     * <p>Serialization contract — every port MUST match this exactly:</p>
     * <ul>
     *   <li>2-space indentation.</li>
     *   <li>Object key order fixed by construction: {@code types}, {@code commonAttrs},
     *       {@code defaultSubTypes}; each type as {@code type}, {@code subType},
     *       {@code attrs}; each attr as {@code name}, {@code valueType},
     *       {@code required}.</li>
     *   <li>All arrays sorted (ASCII/codepoint compare): {@code types} by
     *       "type.subType"; {@code attrs} by name; {@code commonAttrs} by name;
     *       {@code defaultSubTypes} keys sorted.</li>
     *   <li>{@code valueType: null} literal for polymorphic/untyped attrs.</li>
     *   <li>A single trailing newline.</li>
     * </ul>
     *
     * <p>The sort uses {@link String#compareTo} which, for the metamodel's
     * ASCII-only identifiers, is exactly a UTF-16-code-unit (== codepoint)
     * compare — byte-identical to the TS reference's {@code a < b} string
     * compare.</p>
     */
    public static String emit(MetaDataRegistry registry) {
        // types: sorted by "type.subType"
        List<ManifestType> types = new ArrayList<>();
        for (MetaDataTypeId id : registry.getRegisteredTypes()) {
            types.add(new ManifestType(id.type(), id.subType(),
                attrsOf(registry, id.type(), id.subType())));
        }
        types.sort(Comparator.comparing(t -> t.type() + "." + t.subType()));

        // commonAttrs: sorted by name. An array-shaped common attr maps to the
        // "stringarray" value-type (the cross-port vocabulary for an array attr).
        List<ManifestAttr> commonAttrs = new ArrayList<>();
        for (CommonAttributeDef def : registry.getCommonAttributes()) {
            String valueType = def.isArray()
                ? com.metaobjects.attr.StringArrayAttribute.SUBTYPE_STRING_ARRAY
                : def.valueType();
            commonAttrs.add(new ManifestAttr(def.name(), valueType, false));
        }
        commonAttrs.sort(Comparator.comparing(ManifestAttr::name));

        // defaultSubTypes: probe each distinct registered type name; sorted keys.
        TreeSet<String> typeNames = new TreeSet<>();
        for (ManifestType t : types) {
            typeNames.add(t.type());
        }
        Map<String, String> defaultSubTypes = new TreeMap<>();
        for (String typeName : typeNames) {
            String defaultSub = registry.defaultSubTypeOf(typeName);
            if (defaultSub != null) {
                defaultSubTypes.put(typeName, defaultSub);
            }
        }

        return serialize(types, commonAttrs, defaultSubTypes);
    }

    // ------------------------------------------------------------------
    // Hand-rolled JSON serialization (2-space indent, fixed key order)
    // ------------------------------------------------------------------

    private static String serialize(List<ManifestType> types,
                                    List<ManifestAttr> commonAttrs,
                                    Map<String, String> defaultSubTypes) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");

        // "types": [ ... ]
        sb.append("  \"types\": [");
        if (types.isEmpty()) {
            sb.append("],\n");
        } else {
            sb.append('\n');
            for (int i = 0; i < types.size(); i++) {
                ManifestType t = types.get(i);
                sb.append("    {\n");
                sb.append("      \"type\": ").append(jsonString(t.type())).append(",\n");
                sb.append("      \"subType\": ").append(jsonString(t.subType())).append(",\n");
                sb.append("      \"attrs\": ");
                appendAttrs(sb, t.attrs(), "      ");
                sb.append('\n');
                sb.append("    }");
                sb.append(i + 1 < types.size() ? ",\n" : "\n");
            }
            sb.append("  ],\n");
        }

        // "commonAttrs": [ ... ]
        sb.append("  \"commonAttrs\": ");
        appendAttrs(sb, commonAttrs, "  ");
        sb.append(",\n");

        // "defaultSubTypes": { ... }
        sb.append("  \"defaultSubTypes\": {");
        if (defaultSubTypes.isEmpty()) {
            sb.append("}\n");
        } else {
            sb.append('\n');
            int i = 0;
            int n = defaultSubTypes.size();
            for (Map.Entry<String, String> e : defaultSubTypes.entrySet()) {
                sb.append("    ").append(jsonString(e.getKey())).append(": ")
                  .append(jsonString(e.getValue()));
                sb.append(++i < n ? ",\n" : "\n");
            }
            sb.append("  }\n");
        }

        sb.append("}\n");
        return sb.toString();
    }

    /**
     * Append an attrs array at the given base indent (the indent of the line the
     * opening {@code [} sits on). Matches {@code JSON.stringify(_, _, 2)} layout.
     */
    private static void appendAttrs(StringBuilder sb, List<ManifestAttr> attrs, String baseIndent) {
        if (attrs.isEmpty()) {
            sb.append("[]");
            return;
        }
        String itemIndent = baseIndent + "  ";
        String fieldIndent = itemIndent + "  ";
        sb.append("[\n");
        for (int i = 0; i < attrs.size(); i++) {
            ManifestAttr a = attrs.get(i);
            sb.append(itemIndent).append("{\n");
            sb.append(fieldIndent).append("\"name\": ").append(jsonString(a.name())).append(",\n");
            sb.append(fieldIndent).append("\"valueType\": ")
              .append(a.valueType() == null ? "null" : jsonString(a.valueType())).append(",\n");
            sb.append(fieldIndent).append("\"required\": ").append(a.required() ? "true" : "false").append('\n');
            sb.append(itemIndent).append('}');
            sb.append(i + 1 < attrs.size() ? ",\n" : "\n");
        }
        sb.append(baseIndent).append(']');
    }

    /**
     * JSON-encode a string the way {@code JSON.stringify} does for the ASCII
     * identifiers in the metamodel vocabulary (the only chars that ever appear
     * here are letters, digits, {@code .}, {@code _}). Escapes the JSON-mandatory
     * control/quote/backslash chars defensively.
     */
    private static String jsonString(String s) {
        StringBuilder out = new StringBuilder(s.length() + 2);
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
        return out.toString();
    }
}
