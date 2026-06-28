package com.metaobjects.generator.template;

import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.object.MetaObject;
import com.metaobjects.relationship.MetaRelationship;
import com.metaobjects.validator.MetaValidator;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * The NEUTRAL, structural codegen template data dict (SP-1 §3.2) for the JVM.
 * Built as {@link LinkedHashMap}/{@link ArrayList} so the JMustache render reads
 * the same keys the TypeScript object exposes — the field names here are a
 * byte-gated cross-port contract (verified against the TS-produced
 * {@code fixtures/template-codegen-conformance/expected/}). Optional keys
 * ({@code maxLength}, {@code enumValues}) are OMITTED when absent so a
 * {@code {{#maxLength}}} section gates identically to TS.
 */
public final class TemplateData {

    private TemplateData() {}

    private static final String SUBTYPE_ENUM = "enum";
    private static final String VALIDATOR_REQUIRED = "required";

    /** Bare object name — {@code getName()} returns the FQN ({@code shop::Product}),
     *  but the dict's {@code name} is the bare leaf ({@code Product}). */
    public static String bareName(MetaObject o) {
        String n = o.getName();
        int i = n.lastIndexOf("::");
        return i >= 0 ? n.substring(i + 2) : n;
    }

    /** Effective package — {@code getPackage()} already returns the file package
     *  on the JVM (e.g. {@code shop}); null collapses to "". */
    public static String packageOf(MetaObject o) {
        String p = o.getPackage();
        return p == null ? "" : p;
    }

    public static boolean isConcrete(MetaObject o) {
        return !GeneratorUtil.isAbstract(o);
    }

    private static boolean isRequired(MetaField f) {
        if (f.hasMetaAttr(MetaField.ATTR_REQUIRED, false)
            && "true".equals(f.getMetaAttr(MetaField.ATTR_REQUIRED, false).getValueAsString())) {
            return true;
        }
        for (MetaValidator v : f.getChildren(MetaValidator.class)) {
            if (VALIDATOR_REQUIRED.equals(v.getSubType())) return true;
        }
        return false;
    }

    private static Map<String, Object> fieldData(MetaField f) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("name", f.getName());
        d.put("type", f.getSubType());
        d.put("required", isRequired(f));
        d.put("isArray", f.isArrayType());
        if (f.hasMetaAttr(MetaField.ATTR_MAX_LENGTH, false)) {
            d.put("maxLength", Integer.valueOf(f.getMetaAttr(MetaField.ATTR_MAX_LENGTH, false).getValueAsString()));
        }
        if (SUBTYPE_ENUM.equals(f.getSubType()) && f.hasMetaAttr(EnumField.ATTR_VALUES)) {
            Object raw = f.getMetaAttr(EnumField.ATTR_VALUES).getValue();
            List<String> values = new ArrayList<>();
            if (raw instanceof List<?> list) {
                for (Object v : list) values.add(String.valueOf(v));
            } else if (raw instanceof Object[] arr) {
                for (Object v : arr) values.add(String.valueOf(v));
            }
            d.put("enumValues", values);
        }
        return d;
    }

    public static Map<String, Object> entity(MetaObject o) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("name", bareName(o));
        d.put("package", packageOf(o));

        List<Map<String, Object>> fields = new ArrayList<>();
        for (MetaField f : o.getMetaFields()) fields.add(fieldData(f));
        d.put("fields", fields);

        List<Map<String, Object>> identities = new ArrayList<>();
        for (MetaIdentity id : o.getChildren(MetaIdentity.class)) {
            Map<String, Object> i = new LinkedHashMap<>();
            i.put("kind", id.getSubType());
            i.put("fields", new ArrayList<>(id.getFields()));
            identities.add(i);
        }
        d.put("identities", identities);

        List<Map<String, Object>> relationships = new ArrayList<>();
        for (MetaRelationship r : o.getChildren(MetaRelationship.class)) {
            Map<String, Object> rel = new LinkedHashMap<>();
            rel.put("name", r.getName());
            rel.put("cardinality", r.getCardinality() == null ? "" : r.getCardinality());
            rel.put("targetRef", r.getObjectRef() == null ? "" : r.getObjectRef());
            relationships.add(rel);
        }
        d.put("relationships", relationships);
        return d;
    }

    public static Map<String, Object> pkg(String p, List<MetaObject> entities) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("package", p);
        List<Map<String, Object>> ents = new ArrayList<>();
        for (MetaObject o : entities) ents.add(entity(o));
        d.put("entities", ents);
        return d;
    }

    /** Concrete-only, grouped by package ascending, entities in iteration order. */
    public static Map<String, Object> model(List<MetaObject> objects) {
        Map<String, List<MetaObject>> byPkg = new TreeMap<>();
        for (MetaObject o : objects) {
            if (!isConcrete(o)) continue;
            byPkg.computeIfAbsent(packageOf(o), k -> new ArrayList<>()).add(o);
        }
        List<Map<String, Object>> packages = new ArrayList<>();
        for (Map.Entry<String, List<MetaObject>> e : byPkg.entrySet()) {
            packages.add(pkg(e.getKey(), e.getValue()));
        }
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("packages", packages);
        return d;
    }
}
