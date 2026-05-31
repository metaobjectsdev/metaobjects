/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.object.recover;

import com.metaobjects.MetaData;
import com.metaobjects.field.BooleanField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.render.recover.FieldKind;
import com.metaobjects.render.recover.FieldSpec;
import com.metaobjects.render.recover.Format;
import com.metaobjects.render.recover.Normalize;
import com.metaobjects.render.recover.Recover;
import com.metaobjects.render.recover.RecoverOptions;
import com.metaobjects.render.recover.RecoverOutcome;
import com.metaobjects.render.recover.RecoverSchema;
import com.metaobjects.render.recover.RecoveryResult;
import com.metaobjects.util.MetaDataUtil;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;

/**
 * Phase B (metadata-driven recover) runtime entry point — the keystone that turns dirty
 * LLM text into a populated, typed object graph.
 *
 * <p>This is the runtime bridge between the two halves of the standard:</p>
 * <ul>
 *   <li>the <b>recover engine</b> ({@code metaobjects-render}: {@link RecoverSchema} /
 *       {@link FieldSpec} / {@link Recover}) — parses dirty JSON/XML into a forgiving
 *       {@code Map}/{@code List} tree + a {@link com.metaobjects.render.recover.RecoveryReport};</li>
 *   <li>the <b>Phase A runtime object model</b> ({@code metaobjects-metadata}:
 *       {@link MetaObject#newInstance()} + {@link MetaField} get/set SPI +
 *       {@link MetaDataUtil#getObjectRef(MetaField)}) — instantiates the right type
 *       (ValueObject or a registered/bound class) with the correct back-reference.</li>
 * </ul>
 *
 * <p><b>Siting.</b> {@code render} is zero-core-dependency by design (it cannot see
 * {@link MetaObject}), and {@code metadata} sits below {@code render}; neither can host a
 * bridge that needs both. This class lives in {@code metaobjects-om} (the ObjectManager
 * runtime), which sits above both — the natural home for a runtime API (NOT codegen).</p>
 *
 * <p><b>Contract.</b> {@link #recover(MetaObject, String, Format, RecoverOptions)} NEVER
 * throws: lost/malformed fields are classified in the report, never raised. Opt into
 * strictness with {@link RecoveryResult#orThrow()} (added in {@code render}), which throws
 * a {@link com.metaobjects.render.recover.RecoverException} iff a required field was lost.</p>
 *
 * <p><b>Reflection-free.</b> Assembly uses {@link MetaObject#newInstance()} (the self-
 * registering {@link com.metaobjects.registry.ObjectClassRegistry} resolves the bound type)
 * and the {@link MetaField} set-by-name SPI — no {@code Class.forName}.</p>
 *
 * <p><b>Cycle/depth guard.</b> Both {@link #recoverSchemaFor(MetaObject, Format)} (schema
 * recursion) and {@link #assemble(MetaObject, Map)} (object recursion) carry an identity
 * visited-set of {@link MetaObject}s plus a depth counter bounded by {@link #MAX_NEST_DEPTH}
 * (shared cross-port; mirrors the render {@code OutputFormatRenderer} + FR-012). A cyclic or
 * over-deep value-object graph stops recursing and treats the offending field as an opaque
 * STRING leaf, so recover can never infinite-loop.</p>
 */
public final class MetaObjectRecover {

    /**
     * Maximum nested-object recursion depth. Mirrors the render
     * {@code OutputFormatRenderer.MAX_NEST_DEPTH} (and FR-012) — must stay identical
     * cross-port. At or beyond this depth a nested OBJECT field becomes an opaque STRING
     * leaf instead of recursing.
     */
    public static final int MAX_NEST_DEPTH = 8;

    private MetaObjectRecover() { /* no instances */ }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Recover {@code text} into a typed object graph described by {@code mo}, defaulting to
     * {@link Format#JSON} and {@link RecoverOptions#defaults()}.
     *
     * @return a {@link RecoveryResult} whose {@code data} is the assembled object (a
     *         {@link com.metaobjects.object.value.ValueObject} unless a type is bound for
     *         the FQN) and whose {@code report} classifies every field. Never {@code null};
     *         never throws.
     */
    public static RecoveryResult<Object> recover(MetaObject mo, String text) {
        return recover(mo, text, Format.JSON, RecoverOptions.defaults());
    }

    /**
     * Recover {@code text} into a typed object graph described by {@code mo}, defaulting to
     * {@link RecoverOptions#defaults()}.
     */
    public static RecoveryResult<Object> recover(MetaObject mo, String text, Format format) {
        return recover(mo, text, format, RecoverOptions.defaults());
    }

    /**
     * Recover {@code text} into a typed object graph described by {@code mo}.
     *
     * <p>Pipeline: build a {@link RecoverSchema} from {@code mo} (driven entirely by
     * metadata), run the engine to get a forgiving {@code Map}/{@code List} tree + report,
     * then {@linkplain #assemble assemble} that tree into a populated object graph.</p>
     *
     * @param mo     the object describing the expected shape (the single source of truth)
     * @param text   the dirty model output
     * @param format JSON or XML — drives the engine's locate/parse
     * @param opts   bounded runtime overrides (aliases/normalizers/onField/tolerance)
     * @return assembled object + report; NEVER {@code null}; NEVER throws
     */
    public static RecoveryResult<Object> recover(MetaObject mo, String text, Format format, RecoverOptions opts) {
        RecoverSchema schema = recoverSchemaFor(mo, format);
        RecoverOutcome outcome = Recover.recover(text, schema, opts == null ? RecoverOptions.defaults() : opts);
        Object obj = assemble(mo, outcome.data());
        return new RecoveryResult<>(obj, outcome.report());
    }

    // =========================================================================
    // recoverSchemaFor — metadata -> RecoverSchema
    // =========================================================================

    /**
     * Build a {@link RecoverSchema} for {@code mo}, defaulting to {@link Format#JSON}.
     *
     * @see #recoverSchemaFor(MetaObject, Format)
     */
    public static RecoverSchema recoverSchemaFor(MetaObject mo) {
        return recoverSchemaFor(mo, Format.JSON);
    }

    /**
     * Build a {@link RecoverSchema} for {@code mo} by walking its {@link MetaObject#getMetaFields()}
     * and mapping each {@link MetaField} to a {@link FieldSpec}. Recurses into nested OBJECT
     * fields via {@link MetaDataUtil#getObjectRef(MetaField)}, guarded against cycles/over-depth.
     */
    public static RecoverSchema recoverSchemaFor(MetaObject mo, Format format) {
        return recoverSchemaFor(mo, format, newVisited(), 0);
    }

    private static RecoverSchema recoverSchemaFor(MetaObject mo, Format format,
                                                  Set<MetaObject> visited, int depth) {
        visited.add(mo);
        List<FieldSpec> fields = new ArrayList<>();
        for (MetaField<?> field : mo.getMetaFields()) {
            fields.add(fieldSpecFor(field, mo, format, visited, depth));
        }
        visited.remove(mo);
        // rootName is the simple (short) name; the engine's XML locate uses it as the root tag.
        return new RecoverSchema(format, mo.getShortName(), fields);
    }

    private static FieldSpec fieldSpecFor(MetaField<?> field, MetaObject owner, Format format,
                                          Set<MetaObject> visited, int depth) {
        String name = field.getName();
        boolean required = isRequired(field);

        // --- Enum (scalar or array) -----------------------------------------
        if (field instanceof EnumField ef) {
            List<String> values = enumValues(ef);
            Map<String, String> aliases = enumAliases(ef);
            String coerceDefault = ownAttrString(ef, EnumField.ATTR_COERCE_DEFAULT);
            String defaultValue = ownAttrString(ef, EnumField.ATTR_DEFAULT);
            String normalize = resolveNormalize(ef, owner);
            if (field.isArrayType()) {
                return FieldSpec.enumArray(name, required, values, aliases, coerceDefault, normalize, defaultValue);
            }
            return FieldSpec.enumField(name, required, values, aliases, coerceDefault, normalize, defaultValue);
        }

        // --- Nested object (single or array) --------------------------------
        if (field instanceof ObjectField || MetaDataUtil.hasObjectRef(field)) {
            MetaObject ref = MetaDataUtil.getObjectRef(field);
            boolean cyclicOrDeep = ref == null || visited.contains(ref) || depth + 1 >= MAX_NEST_DEPTH;
            if (cyclicOrDeep) {
                // Opaque leaf — never recurse into a cycle / past the depth bound.
                return FieldSpec.scalar(name, FieldKind.STRING, required);
            }
            RecoverSchema nested = recoverSchemaFor(ref, format, visited, depth + 1);
            return FieldSpec.object(name, required, field.isArrayType(), nested);
        }

        // --- Scalar (carry generalized @default) ----------------------------
        FieldKind kind = scalarKind(field);
        String defaultValue = ownAttrString(field, MetaField.ATTR_DEFAULT);
        return FieldSpec.scalar(name, kind, required, defaultValue);
    }

    // =========================================================================
    // assemble — recovered Map/List tree -> object graph
    // =========================================================================

    /**
     * Assemble a recovered {@code Map<String,Object>} (the engine's forgiving tree) into a
     * populated object graph described by {@code mo}.
     *
     * <p>{@code mo.newInstance()} yields the bound type (or a ValueObject) with the back-ref
     * already set. Each field's value is written via the {@link MetaField} SPI:</p>
     * <ul>
     *   <li>scalar / enum / scalar-array / enum-array → {@code field.setObject(o, value)}
     *       (the engine already coerced the value to the right kind; arrays arrive as a List);</li>
     *   <li>OBJECT non-array → recursively {@code assemble} the child Map, then
     *       {@code field.setObject(o, child)};</li>
     *   <li>OBJECT array → recursively {@code assemble} each element Map into a List, then
     *       {@code field.setObjectArray(o, list)}.</li>
     * </ul>
     *
     * <p>Cycle/depth-guarded identically to {@link #recoverSchemaFor}: a cyclic/over-deep
     * nested field is left null rather than recursed.</p>
     *
     * @return the assembled object (NEVER throws on lost/malformed data — those were
     *         classified in the report during the engine pass).
     */
    public static Object assemble(MetaObject mo, Map<String, Object> data) {
        return assemble(mo, data, newVisited(), 0);
    }

    @SuppressWarnings("unchecked")
    private static Object assemble(MetaObject mo, Map<String, Object> data,
                                   Set<MetaObject> visited, int depth) {
        Object o = mo.newInstance();
        if (data == null) {
            return o;
        }
        visited.add(mo);
        for (MetaField<?> field : mo.getMetaFields()) {
            String name = field.getName();
            Object value = data.get(name);

            boolean isObjectField = field instanceof ObjectField || MetaDataUtil.hasObjectRef(field);
            // Enum fields are string-backed scalars/arrays — treat them as scalar assignment.
            if (!isObjectField || field instanceof EnumField) {
                // scalar / enum / scalar-array / enum-array: engine already coerced it.
                if (value != null) {
                    if (field.isArrayType() && value instanceof List) {
                        // Route a scalar/enum List through the object's setValue, which coerces
                        // via the array-equivalent data type (e.g. STRING -> STRING_ARRAY) — the
                        // element-by-element scalar setObjectArray guard rejects a List for a
                        // scalar field whose value-class is the element type.
                        mo.setValue(field, o, value);
                    } else {
                        field.setObject(o, value);
                    }
                }
                continue;
            }

            // Nested object — guard cycles/depth (mirror the schema guard).
            MetaObject ref = MetaDataUtil.getObjectRef(field);
            boolean cyclicOrDeep = ref == null || visited.contains(ref) || depth + 1 >= MAX_NEST_DEPTH;

            if (field.isArrayType()) {
                // Array-of-objects: map each element Map -> assembled child.
                if (value instanceof List<?> elems) {
                    List<Object> children = new ArrayList<>(elems.size());
                    for (Object elem : elems) {
                        if (elem instanceof Map && !cyclicOrDeep) {
                            children.add(assemble(ref, (Map<String, Object>) elem, visited, depth + 1));
                        }
                    }
                    field.setObjectArray(o, children);
                }
                // absent array stays absent (the engine reports it; null/empty per report).
            } else {
                // Single object.
                if (value instanceof Map && !cyclicOrDeep) {
                    Object child = assemble(ref, (Map<String, Object>) value, visited, depth + 1);
                    field.setObject(o, child);
                }
                // else leave null.
            }
        }
        visited.remove(mo);
        return o;
    }

    // =========================================================================
    // Enum-attr reading (mirrors codegen-spring RecoverSchemaEmitter.enumFieldSpec)
    // =========================================================================

    @SuppressWarnings("unchecked")
    private static List<String> enumValues(EnumField field) {
        // @values — guaranteed non-null by the loader's ValidationPhase.
        return (List<String>) field.getMetaAttr(EnumField.ATTR_VALUES).getValue();
    }

    private static Map<String, String> enumAliases(EnumField field) {
        if (!field.hasMetaAttr(EnumField.ATTR_ENUM_ALIAS, false)) {
            return Map.of();
        }
        Object raw = field.getMetaAttr(EnumField.ATTR_ENUM_ALIAS).getValue();
        if (!(raw instanceof Properties props) || props.isEmpty()) {
            return Map.of();
        }
        Map<String, String> aliases = new java.util.LinkedHashMap<>();
        for (String key : props.stringPropertyNames()) {
            aliases.put(key, props.getProperty(key));
        }
        return aliases;
    }

    /**
     * Resolve the enum normalization mode: field-level {@code @normalize}, else the owning
     * object's {@code @normalize}, else the global default ("strip"). Mirrors the
     * codegen-spring {@code RecoverSchemaEmitter.resolveNormalize}.
     */
    private static String resolveNormalize(MetaField<?> field, MetaObject owner) {
        String fieldMode = ownAttrString(field, EnumField.ATTR_NORMALIZE);
        if (fieldMode != null) return fieldMode;
        String objMode = owner == null ? null : ownAttrString(owner, EnumField.ATTR_NORMALIZE);
        if (objMode != null) return objMode;
        return Normalize.DEFAULT;
    }

    // =========================================================================
    // Common helpers
    // =========================================================================

    /** The own (non-inherited) string value of an attr on a node, or {@code null} when absent/empty. */
    private static String ownAttrString(MetaData node, String attr) {
        if (!node.hasMetaAttr(attr, false)) return null;
        String s = node.getMetaAttr(attr, false).getValueAsString();
        return (s == null || s.isEmpty()) ? null : s;
    }

    /** Returns {@code true} when the field carries {@code @required: true}. */
    private static boolean isRequired(MetaField<?> field) {
        return field.hasMetaAttr(MetaField.ATTR_REQUIRED)
            && "true".equalsIgnoreCase(field.getMetaAttr(MetaField.ATTR_REQUIRED).getValueAsString());
    }

    /**
     * Map a scalar {@link MetaField} to its {@link FieldKind} (same {@code instanceof} order
     * as the codegen-spring {@code SpringTypeMapper}). Unknown types fall back to STRING.
     */
    private static FieldKind scalarKind(MetaField<?> field) {
        if (field instanceof StringField)  return FieldKind.STRING;
        if (field instanceof IntegerField) return FieldKind.INT;
        if (field instanceof LongField)    return FieldKind.LONG;
        if (field instanceof DoubleField)  return FieldKind.DOUBLE;
        if (field instanceof BooleanField) return FieldKind.BOOLEAN;
        return FieldKind.STRING;
    }

    /** A fresh identity-based visited set for the cycle guard. */
    private static Set<MetaObject> newVisited() {
        return Collections.newSetFromMap(new IdentityHashMap<>());
    }
}
