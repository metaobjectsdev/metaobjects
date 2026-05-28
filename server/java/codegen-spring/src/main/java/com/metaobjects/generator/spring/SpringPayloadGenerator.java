package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.origin.AggregateOrigin;
import com.metaobjects.origin.CollectionOrigin;
import com.metaobjects.origin.MetaOrigin;
import com.metaobjects.origin.PassthroughOrigin;
import com.metaobjects.relationship.MetaRelationship;
import com.metaobjects.template.MetaTemplate;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/**
 * Generator: one {@code <TemplateShortName>Payload} Java record per
 * {@code template.*} declaration (prompt / output / toolcall), derived from the
 * template's {@code @payloadRef} {@link MetaObject#SUBTYPE_VALUE} object's
 * field tree.
 *
 * <p>The emitted record is the typed wire shape that
 * {@link SpringOutputParserGenerator}'s parser returns for {@code template.output}
 * (and the build-time-typed payload shape consumed by callers for
 * {@code template.prompt} / {@code template.toolcall}). Idiomatic Spring
 * convention: a Java 21 record with no annotations — Jackson handles
 * deserialization positionally + by name without {@code @JsonProperty}
 * decoration when field names match.
 *
 * <p>FR-006 — the Java port of the cross-language template-payload codegen.
 * See {@code docs/superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md}
 * and ADR-0010 for the cross-port contract; this is the Spring-flavoured
 * sibling of TS's {@code generatePayloadInterfaces()}, C#'s
 * {@code PayloadCodegen}, Kotlin's {@code KotlinPayloadGenerator}, and
 * Python's payload module.
 *
 * <p>Output package mirrors Kotlin: {@code <entity-pkg>.prompts} when the
 * template lives under a package (so {@code acme::ai::NpcResponseOutput}
 * lands in {@code acme.ai.prompts.NpcResponseOutputPayload}), and the
 * bare {@code prompts} package when no metadata package is set.
 *
 * <p>Origin-aware: each field on the payload VO may carry an {@code origin.*}
 * child that declares how the value is derived. The record component's Java
 * type is resolved as:
 * <ul>
 *   <li>{@code origin.passthrough} ({@code @from "Entity.field"}) — type of the
 *       referenced source field.</li>
 *   <li>{@code origin.aggregate} ({@code @agg count}) — {@code Long};
 *       ({@code @agg avg}) — {@code Double};
 *       ({@code @agg sum|min|max}) — type of the referenced {@code @of} field.</li>
 *   <li>{@code origin.collection} ({@code @via "Parent.rel"}) —
 *       {@code List<TargetPayload>}, and the nested payload class is recursively
 *       emitted alongside (deduped per {@link #execute(MetaDataLoader)} run).</li>
 *   <li>{@code field.object} with {@code @objectRef} (no {@code origin.*} child) —
 *       recursively emit {@code <TargetShortName>Payload} (per-run deduped) and
 *       return that type, or {@code java.util.List<TargetPayload>} when the field
 *       is {@code isArray: true}. Mirrors Kotlin's plain {@code ObjectField}
 *       arm.</li>
 *   <li>No origin child and not a {@code field.object} — fall back to
 *       {@link SpringTypeMapper#javaTypeName(MetaField)}.</li>
 * </ul>
 *
 * <p>Class-naming convention: the emitted record name is
 * {@code <PascalCaseTemplateShortName>Payload}. Templates declared in
 * {@code camelCase} (e.g. {@code adjudicationUser}) are capitalised before
 * appending {@code Payload}, matching Kotlin/C#/TS/Python and Java's own
 * PascalCase class-naming convention. Nested payload class names from
 * {@code origin.collection} / {@code field.object} arms are capitalised the
 * same way.
 *
 * <p>Skips and defensive cases:
 * <ul>
 *   <li>Missing {@code @payloadRef} — skipped (loader's validation pass
 *       normally rejects this first; defensive only).</li>
 *   <li>{@code @payloadRef} resolves to a non-VO target — skipped (payloads
 *       must be {@code object.value}; matches the cross-port contract).</li>
 *   <li>Templates are processed in stable name order for deterministic emission.</li>
 * </ul>
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringPayloadGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());

        // Dedupe nested payload classes emitted via origin.collection across
        // all templates in this run. Key = FQN of the source value-object the
        // nested payload was generated from. Mirrors KotlinPayloadGenerator.
        Set<String> emittedNestedFqns = new HashSet<>();

        // Stable name order — matches the other ports' deterministic emission.
        // Iterate ALL MetaTemplate subtypes (prompt / output / toolcall);
        // every template with a @payloadRef gets a payload record.
        List<MetaTemplate> templates = new ArrayList<>();
        for (MetaData child : loader.getRoot().getChildren()) {
            if (child instanceof MetaTemplate t) {
                templates.add(t);
            }
        }
        templates.sort(Comparator.comparing(MetaTemplate::getName));

        for (MetaTemplate tmpl : templates) {
            emit(tmpl, loader, outRoot, emittedNestedFqns);
        }
    }

    private void emit(MetaTemplate template, MetaDataLoader loader, Path outRoot,
                      Set<String> emittedNestedFqns) {
        String payloadRef = template.getPayloadRef();
        if (payloadRef == null || payloadRef.isEmpty()) {
            return; // loader validation normally catches this first
        }
        MetaObject payloadVo = resolveValueObject(loader, payloadRef);
        if (payloadVo == null) {
            return; // not a VO — same contract as Kotlin / C# / Python
        }

        String[] split = SpringNaming.splitFqn(template.getName());
        String templatePkg = split[0];
        String templateShort = split[1];
        String outPkg = templatePkg.isEmpty() ? "prompts" : templatePkg + ".prompts";
        String recordName = capitalizeFirst(templateShort) + "Payload";

        emitPayloadRecord(
            outPkg,
            recordName,
            "GENERATED — payload for template `" + template.getName() + "`. "
                + "Do not hand-edit; regenerated from metadata.",
            payloadVo,
            loader,
            outRoot,
            emittedNestedFqns);
    }

    /**
     * Emit a single Java record for {@code voObject} into
     * {@code <outPkg>.<recordName>}, resolving each component's type via
     * {@link #resolveFieldType}. When a field has an {@code origin.collection},
     * recursively emits its nested payload record first (per-run deduped via
     * {@code emittedNestedFqns}).
     */
    private void emitPayloadRecord(String outPkg,
                                   String recordName,
                                   String banner,
                                   MetaObject voObject,
                                   MetaDataLoader loader,
                                   Path outRoot,
                                   Set<String> emittedNestedFqns) {
        StringBuilder src = new StringBuilder();
        src.append("package ").append(outPkg).append(";\n\n");
        src.append("/** ").append(banner).append(" */\n");
        src.append("public record ").append(recordName).append("(\n");

        // Capture (type, name) pairs as we emit constructor params so we can
        // emit hasFoo() helpers in the record body afterwards. Records can
        // declare arbitrary instance methods alongside the canonical
        // components; Jackson serialization remains positional + by-name on
        // the canonical components only, so the helpers don't leak into JSON.
        List<String[]> components = new ArrayList<>();

        // Route every field through resolveFieldType — including ObjectField,
        // which needs the field.object arm (single ref or isArray list). The
        // previous scalarFields() filter dropped ObjectField entirely; mirror
        // KotlinPayloadGenerator's no-filter iteration. getMetaFields()
        // returns Collection, so go through the iterator directly.
        Iterator<MetaField> it = voObject.getMetaFields().iterator();
        while (it.hasNext()) {
            MetaField field = it.next();
            String type = resolveFieldType(field, loader, outPkg, outRoot, emittedNestedFqns);
            src.append("    ").append(type).append(' ').append(field.getName());
            if (it.hasNext()) src.append(',');
            src.append('\n');
            components.add(new String[] { type, field.getName() });
        }

        // Emit hasFoo() instance methods for nullable, possibly-empty fields
        // so Mustache section gates ({{#hasFoo}}...{{/hasFoo}}) work natively
        // without hand-written wrappers. Rules:
        //   - String       → return foo != null && !foo.isBlank();
        //   - List<...>    → return foo != null && !foo.isEmpty();
        //   - reference T  → return foo != null;   (any non-primitive,
        //                                           non-boxed-primitive,
        //                                           non-String, non-List)
        //   - primitive / boxed primitive → skip (no hasFoo emitted; these
        //     are typically always-present scalars in our templates).
        List<String[]> helpers = new ArrayList<>();
        for (String[] c : components) {
            String type = c[0];
            String name = c[1];
            String helperBody = hasHelperBody(type, name);
            if (helperBody != null) {
                helpers.add(new String[] { name, helperBody });
            }
        }
        if (helpers.isEmpty()) {
            src.append(") {}\n");
        } else {
            src.append(") {\n");
            for (String[] h : helpers) {
                String methodName = "has" + capitalizeFirst(h[0]);
                src.append("    public boolean ").append(methodName).append("() { ")
                   .append(h[1]).append(" }\n");
            }
            src.append("}\n");
        }

        try {
            Path outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve(recordName + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + recordName + ".java for value-object " + voObject.getName() + ": " + e, e);
        }
    }

    /**
     * Resolve the Java type expression of a single payload-VO field. Precedence:
     * (1) {@code origin.*} child wins if present; (2) otherwise a
     * {@code field.object} routes through the nested-payload emission arm; (3)
     * otherwise the scalar fallback via {@link SpringTypeMapper#javaTypeName}.
     */
    private String resolveFieldType(MetaField<?> field,
                                    MetaDataLoader loader,
                                    String nestedPkg,
                                    Path outRoot,
                                    Set<String> emittedNestedFqns) {
        MetaOrigin origin = firstOriginChild(field);
        if (origin instanceof PassthroughOrigin pt) {
            return resolvePassthroughType(pt, loader, field);
        }
        if (origin instanceof AggregateOrigin ag) {
            return resolveAggregateType(ag, loader, field);
        }
        if (origin instanceof CollectionOrigin co) {
            return resolveCollectionType(co, loader, nestedPkg, outRoot, emittedNestedFqns, field);
        }
        if (field instanceof ObjectField of) {
            return resolveObjectFieldType(of, loader, nestedPkg, outRoot, emittedNestedFqns);
        }
        return SpringTypeMapper.javaTypeName(field);
    }

    /**
     * Naked {@code field.object @objectRef}: recursively emit
     * {@code <CapitalizedTargetShortName>Payload} for the referenced VO, and
     * return that type — or {@code java.util.List<TargetPayload>} when
     * {@code isArray: true}. Mirrors Kotlin's plain-{@code ObjectField} arm in
     * {@code KotlinPayloadGenerator.resolveFieldType}.
     */
    private String resolveObjectFieldType(ObjectField field,
                                          MetaDataLoader loader,
                                          String nestedPkg,
                                          Path outRoot,
                                          Set<String> emittedNestedFqns) {
        MetaObject target = field.getObjectRef();
        if (target == null) return SpringTypeMapper.javaTypeName(field);
        if (!MetaObject.SUBTYPE_VALUE.equals(target.getSubType())) {
            // Same payload-VO contract as @payloadRef — nested payloads must
            // themselves be object.value. Loader validation normally catches
            // this; defensive fallback to scalar type.
            return SpringTypeMapper.javaTypeName(field);
        }
        return emitNestedAndReturnType(target, loader, nestedPkg, outRoot, emittedNestedFqns, field.isArray());
    }

    /**
     * {@code origin.passthrough @from "Entity.field"}: resolve to the source
     * field's Java type. Falls back to the payload field's own type if the
     * dotted ref can't be resolved (defensive — the loader's ValidationPhase
     * already gates {@code @from} being present and well-formed).
     */
    private String resolvePassthroughType(PassthroughOrigin origin,
                                          MetaDataLoader loader,
                                          MetaField<?> fallbackField) {
        String from = origin.getFrom();
        if (from == null) return SpringTypeMapper.javaTypeName(fallbackField);
        MetaField<?> sourceField = resolveDottedFieldRef(loader, from);
        if (sourceField == null) return SpringTypeMapper.javaTypeName(fallbackField);
        return SpringTypeMapper.javaTypeName(sourceField);
    }

    /**
     * {@code origin.aggregate @agg X @of "Entity.field"}: type rule —
     * <ul>
     *   <li>count → {@code Long}</li>
     *   <li>avg → {@code Double}</li>
     *   <li>sum/min/max → type of the {@code @of} field</li>
     * </ul>
     */
    private String resolveAggregateType(AggregateOrigin origin,
                                        MetaDataLoader loader,
                                        MetaField<?> fallbackField) {
        String agg = origin.getAgg();
        if (MetaOrigin.AGG_COUNT.equals(agg)) return "Long";
        if (MetaOrigin.AGG_AVG.equals(agg)) return "Double";
        if (MetaOrigin.AGG_SUM.equals(agg)
                || MetaOrigin.AGG_MIN.equals(agg)
                || MetaOrigin.AGG_MAX.equals(agg)) {
            String of = origin.getOf();
            if (of == null) return SpringTypeMapper.javaTypeName(fallbackField);
            MetaField<?> sourceField = resolveDottedFieldRef(loader, of);
            if (sourceField == null) return SpringTypeMapper.javaTypeName(fallbackField);
            return SpringTypeMapper.javaTypeName(sourceField);
        }
        return SpringTypeMapper.javaTypeName(fallbackField);
    }

    /**
     * {@code origin.collection @via "Parent.relName"}: walk Parent's relationship
     * {@code relName} to its {@code @objectRef} target value-object, recursively
     * emit a nested payload record ({@code <TargetShortName>Payload}) into
     * {@code nestedPkg}, and return {@code List<TargetPayload>}. Dedupe across
     * the whole run via {@code emittedNestedFqns}.
     */
    private String resolveCollectionType(CollectionOrigin origin,
                                         MetaDataLoader loader,
                                         String nestedPkg,
                                         Path outRoot,
                                         Set<String> emittedNestedFqns,
                                         MetaField<?> fallbackField) {
        String via = origin.getVia();
        if (via == null) return SpringTypeMapper.javaTypeName(fallbackField);
        String[] split = splitDottedRef(via);
        if (split == null) return SpringTypeMapper.javaTypeName(fallbackField);
        String parentName = split[0];
        String relName = split[1];

        MetaObject parent = resolveObjectByShortOrFqn(loader, parentName);
        if (parent == null) return SpringTypeMapper.javaTypeName(fallbackField);

        MetaRelationship relationship = null;
        for (MetaData child : parent.getChildren()) {
            if (!(child instanceof MetaRelationship rel)) continue;
            String relShort = shortName(rel.getName());
            if (rel.getName().equals(relName) || relShort.equals(relName)) {
                relationship = rel;
                break;
            }
        }
        if (relationship == null) return SpringTypeMapper.javaTypeName(fallbackField);

        String targetRef = relationship.getObjectRef();
        if (targetRef == null) return SpringTypeMapper.javaTypeName(fallbackField);

        MetaObject target = resolveObjectByShortOrFqn(loader, targetRef);
        if (target == null) return SpringTypeMapper.javaTypeName(fallbackField);
        return emitNestedAndReturnType(target, loader, nestedPkg, outRoot, emittedNestedFqns, true);
    }

    /**
     * Shared nested-payload emit path used by {@link #resolveCollectionType}
     * (always a list) and {@link #resolveObjectFieldType} (single or list,
     * depending on {@code asList}). Emits the record at most once per run via
     * the {@code emittedNestedFqns} dedupe set, and returns the type expression
     * to use as the parent field's component type. Returns
     * {@code java.util.List<TargetPayload>} (fully-qualified to sidestep any
     * potential {@code List} import collision in generated code) when
     * {@code asList} is true, else just {@code TargetPayload}.
     */
    private String emitNestedAndReturnType(MetaObject target,
                                           MetaDataLoader loader,
                                           String nestedPkg,
                                           Path outRoot,
                                           Set<String> emittedNestedFqns,
                                           boolean asList) {
        String nestedShort = capitalizeFirst(SpringNaming.splitFqn(target.getName())[1]);
        String nestedRecord = nestedShort + "Payload";
        if (emittedNestedFqns.add(target.getName())) {
            emitPayloadRecord(
                nestedPkg,
                nestedRecord,
                "GENERATED — nested payload for `" + target.getName() + "`. "
                    + "Do not hand-edit; regenerated from metadata.",
                target,
                loader,
                outRoot,
                emittedNestedFqns);
        }
        return asList ? "java.util.List<" + nestedRecord + ">" : nestedRecord;
    }

    // -------------------------------------------------------------------------
    // Local helpers (intentionally not in SpringNaming — origin/relationship
    // resolution is payload-specific. If a second generator needs them, lift
    // them up the same way KotlinGenUtil holds its share.)
    // -------------------------------------------------------------------------

    /** First {@link MetaOrigin} child of {@code field}, or {@code null} when absent. */
    private static MetaOrigin firstOriginChild(MetaField<?> field) {
        for (MetaData child : field.getChildren()) {
            if (child instanceof MetaOrigin o) return o;
        }
        return null;
    }

    /**
     * Resolve a dotted {@code "Entity.field"} ref to the {@link MetaField} on
     * Entity (by short name OR FQN match). Returns {@code null} when either
     * half can't be resolved.
     */
    private static MetaField<?> resolveDottedFieldRef(MetaDataLoader loader, String dottedRef) {
        String[] split = splitDottedRef(dottedRef);
        if (split == null) return null;
        MetaObject obj = resolveObjectByShortOrFqn(loader, split[0]);
        if (obj == null) return null;
        String fieldName = split[1];
        for (MetaField<?> field : obj.getMetaFields()) {
            if (field.getName().equals(fieldName) || shortName(field.getName()).equals(fieldName)) {
                return field;
            }
        }
        return null;
    }

    /**
     * Resolve a {@link MetaObject} (entity OR value) by exact FQN or by short
     * name. Returns {@code null} when neither matches.
     */
    private static MetaObject resolveObjectByShortOrFqn(MetaDataLoader loader, String ref) {
        for (MetaObject obj : loader.getMetaObjects()) {
            if (obj.getName().equals(ref) || shortName(obj.getName()).equals(ref)) {
                return obj;
            }
        }
        return null;
    }

    /** Resolve {@code @payloadRef} to its {@code object.value} target (rejects entities). */
    private static MetaObject resolveValueObject(MetaDataLoader loader, String ref) {
        MetaObject obj = resolveObjectByShortOrFqn(loader, ref);
        if (obj == null) return null;
        return MetaObject.SUBTYPE_VALUE.equals(obj.getSubType()) ? obj : null;
    }

    /**
     * Split {@code "A.b"} into {@code ["A", "b"]}; {@code null} if the ref
     * isn't a single-dot ref (no dot, leading dot, or trailing dot).
     */
    private static String[] splitDottedRef(String ref) {
        int dot = ref.indexOf('.');
        if (dot <= 0 || dot >= ref.length() - 1) return null;
        return new String[] { ref.substring(0, dot), ref.substring(dot + 1) };
    }

    /** Trailing segment after the last {@code ::}, or the whole input when no separator. */
    private static String shortName(String fqn) {
        int idx = fqn.lastIndexOf("::");
        return idx < 0 ? fqn : fqn.substring(idx + 2);
    }

    /**
     * Uppercase the first character of {@code s}; pass {@code s} through
     * unchanged when empty or already capitalised. Used to PascalCase the
     * payload record name regardless of whether the template short name was
     * authored as {@code camelCase} or {@code PascalCase}, matching Kotlin /
     * C# / TS / Python convention + Java's PascalCase class-naming rule.
     */
    private static String capitalizeFirst(String s) {
        if (s == null || s.isEmpty()) return s;
        char c0 = s.charAt(0);
        if (Character.isUpperCase(c0)) return s;
        return Character.toUpperCase(c0) + s.substring(1);
    }

    /**
     * Decide whether a record component gets a {@code hasFoo()} instance-method
     * helper, and return the method body if so. The rules mirror what
     * templating consumers actually need to gate Mustache sections:
     *
     * <ul>
     *   <li>{@code String} → {@code return foo != null && !foo.isBlank();}</li>
     *   <li>{@code java.util.List<...>} → {@code return foo != null && !foo.isEmpty();}</li>
     *   <li>Other reference types (any non-primitive, non-boxed-primitive,
     *       non-{@code String}, non-{@code List}) → {@code return foo != null;}</li>
     *   <li>Primitive / boxed-primitive numerics + booleans → skip (always
     *       present in payloads; templates use the value directly).</li>
     * </ul>
     *
     * <p>Returns {@code null} when no helper should be emitted.
     */
    private static String hasHelperBody(String type, String name) {
        if ("String".equals(type)) {
            return "return " + name + " != null && !" + name + ".isBlank();";
        }
        if (type.startsWith("java.util.List<")) {
            return "return " + name + " != null && !" + name + ".isEmpty();";
        }
        // Primitive + boxed primitive scalars: skip — these are always present
        // in our payload shape, and gating Mustache sections on them isn't a
        // pattern we need today. Adding helpers here would just be noise.
        switch (type) {
            case "int":
            case "Integer":
            case "long":
            case "Long":
            case "double":
            case "Double":
            case "float":
            case "Float":
            case "short":
            case "Short":
            case "byte":
            case "Byte":
            case "boolean":
            case "Boolean":
            case "char":
            case "Character":
                return null;
            default:
                // Any other type — nested payload record reference, etc. — is
                // a nullable reference whose presence callers may want to gate.
                return "return " + name + " != null;";
        }
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    @Override
    protected void writeSingleFile(MetaObject md, GeneratorIOWriter<?> writer) { /* unused */ }

    @Override
    @SuppressWarnings({ "unchecked", "rawtypes" })
    protected <T extends GeneratorIOWriter> T getSingleWriter(
            MetaDataLoader loader, MetaObject md, PrintWriter pw) {
        return null;
    }

    @Override
    @SuppressWarnings({ "unchecked", "rawtypes" })
    protected <T extends GeneratorIOWriter> T getFinalWriter(
            MetaDataLoader loader, OutputStream out) {
        return null;
    }

    @Override
    protected void writeFinalFile(Collection<MetaObject> metadata, GeneratorIOWriter<?> writer) { /* none */ }

    @Override
    protected String getSingleOutputFilePath(MetaObject md) {
        return SpringNaming.splitFqn(md.getName())[0].replace('.', '/');
    }

    @Override
    protected String getSingleOutputFilename(MetaObject md) {
        return capitalizeFirst(SpringNaming.splitFqn(md.getName())[1]) + "Payload.java";
    }
}
