package com.metaobjects.generator;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.generator.util.RouteNaming;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.MetaSource;
import com.metaobjects.util.MetaDataUtil;
import com.metaobjects.validator.MetaValidator;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * Everything a generator written from scratch needs to read the model correctly, in one
 * place (ADR-0034 Amendment 4). Pair it with {@link FileEmittingGenerator}.
 *
 * <p>Each helper is a rule the engine already owns, and each has an obvious spelling on the
 * node API that is WRONG:
 * <ul>
 *   <li>{@code getName()} is the fully-qualified {@code shop::Customer}; the bare name is
 *       {@link #name}.</li>
 *   <li>{@code isArray()} is the own-only raw flag; {@link #isArray} resolves through
 *       {@code extends} (ADR-0039).</li>
 *   <li>{@code getMetaAttr(name, false)} is own-only; every read here resolves, so a field
 *       inheriting {@code @required} or {@code @maxLength} from an abstract base keeps it.</li>
 *   <li>{@code @objectRef} resolves package-locally (ADR-0042), never by short name.</li>
 * </ul>
 */
public final class ModelWalk {

    private static final String VALIDATOR_REQUIRED = "required";
    private static final String ATTR_DESCRIPTION = "description";
    private static final String ATTR_FIELDS = "fields";

    private ModelWalk() {}

    /** Every object that is not abstract — the usual starting set. Abstract bases only
     *  contribute fields to what {@code extends} them. */
    public static List<MetaObject> concreteObjects(MetaDataLoader loader) {
        List<MetaObject> out = new ArrayList<>();
        for (MetaObject o : loader.getMetaObjects()) {
            if (!isAbstract(o)) out.add(o);
        }
        return out;
    }

    public static boolean isAbstract(MetaObject o) {
        return GeneratorUtil.isAbstract(o);
    }

    /** The bare object name ({@code Customer}), not {@code getName()}'s FQN. */
    public static String name(MetaObject o) {
        return o.getShortName();
    }

    /** The object's package ({@code shop}), or "" for a root-level object. */
    public static String packageOf(MetaObject o) {
        String p = o.getPackage();
        return p == null ? "" : p;
    }

    /** All fields, own AND inherited through {@code extends}. Order: the object's OWN fields
     *  first, then inherited ones — the other ports list inherited fields first, so sort or
     *  reorder if output must match theirs byte for byte. */
    public static Collection<MetaField> fields(MetaObject o) {
        return o.getMetaFields();
    }

    /** Effective required-ness: {@code @required: true} or a {@code validator.required}
     *  child, own or inherited. */
    public static boolean isRequired(MetaField f) {
        MetaAttribute attr = f.hasMetaAttr(MetaField.ATTR_REQUIRED) ? f.getMetaAttr(MetaField.ATTR_REQUIRED) : null;
        if (attr != null && "true".equals(attr.getValueAsString())) return true;
        for (MetaValidator v : f.getChildren(MetaValidator.class, true)) {
            if (VALIDATOR_REQUIRED.equals(v.getSubType())) return true;
        }
        return false;
    }

    /** Effective array-ness, inherited too (never the raw {@code isArray()} flag). */
    public static boolean isArray(MetaField f) {
        return f.isArrayType();
    }

    /** Effective {@code @maxLength}, or null. */
    public static Integer maxLength(MetaField f) {
        if (!f.hasMetaAttr(MetaField.ATTR_MAX_LENGTH)) return null;
        return Integer.valueOf(f.getMetaAttr(MetaField.ATTR_MAX_LENGTH).getValueAsString());
    }

    /** A {@code field.enum}'s effective {@code @values} (empty when absent). */
    public static List<String> enumValues(MetaField f) {
        List<String> values = new ArrayList<>();
        if (!f.hasMetaAttr(EnumField.ATTR_VALUES)) return values;
        Object raw = f.getMetaAttr(EnumField.ATTR_VALUES).getValue();
        if (raw instanceof List<?> list) {
            for (Object v : list) values.add(String.valueOf(v));
        } else if (raw instanceof Object[] arr) {
            for (Object v : arr) values.add(String.valueOf(v));
        }
        return values;
    }

    /** The object a {@code field.object}'s {@code @objectRef} points at, resolved
     *  package-locally; null when the field carries no ref. */
    public static MetaObject objectRefTarget(MetaField f) {
        if (!f.hasMetaAttr(MetaObject.ATTR_OBJECT_REF)) return null;
        return MetaDataUtil.getObjectRef(f);
    }

    /** The effective {@code @description} of any node, or null. */
    public static String description(MetaData node) {
        return node.hasMetaAttr(ATTR_DESCRIPTION) ? node.getMetaAttr(ATTR_DESCRIPTION).getValueAsString() : null;
    }

    /** The primary identity's field names, own or inherited (empty when none). */
    public static List<String> primaryKeyFields(MetaObject o) {
        PrimaryIdentity pk = o.getPrimaryIdentity();
        List<String> out = new ArrayList<>();
        if (pk == null || !pk.hasMetaAttr(ATTR_FIELDS)) return out;
        Object raw = pk.getMetaAttr(ATTR_FIELDS).getValue();
        if (raw instanceof List<?> list) {
            for (Object v : list) out.add(String.valueOf(v));
        } else if (raw instanceof Object[] arr) {
            for (Object v : arr) out.add(String.valueOf(v));
        } else if (raw != null) {
            for (String s : String.valueOf(raw).split(",")) if (!s.isBlank()) out.add(s.trim());
        }
        return out;
    }

    /** True when the object declares or inherits a {@code source.*} — it is persisted and the
     *  reference routes serve it. */
    public static boolean hasSource(MetaObject o) {
        return !o.getChildren(MetaSource.class, true).isEmpty();
    }

    /** The cross-port REST collection segment the reference routes serve an object at
     *  ({@code PostCategory} → {@code post_categories}). */
    public static String collectionSegment(MetaObject o) {
        return RouteNaming.collectionSegment(o.getShortName());
    }
}
