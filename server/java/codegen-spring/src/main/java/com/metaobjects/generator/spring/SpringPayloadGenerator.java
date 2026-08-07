package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.MetaTemplate;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
 * <p>DECLARED-TYPE-AUTHORITATIVE (#270): a payload field's record-component type
 * comes ONLY from its declared {@code field.<subType>} + {@code isArray} +
 * {@code @objectRef} — never from any {@code origin.*} child it carries (an
 * origin child is IGNORED for typing; the field types exactly as if it were
 * absent). A prompt's payload is a typed projection the author DECLARES, so
 * payload bloat shows up as a diff — matching the origin-blind TS / C# emitters
 * and the converged Kotlin / Python ports. The component type is resolved as:
 * <ul>
 *   <li>{@code field.enum} — the generated nested enum type (single, or
 *       {@code java.util.List<Enum>}).</li>
 *   <li>{@code field.object} with {@code @objectRef} to an {@code object.value} —
 *       recursively emit {@code <TargetShortName>Payload} (per-run deduped) and
 *       return that type, or {@code java.util.List<TargetPayload>} when the field
 *       is {@code isArray: true}. This declared edge is the ONLY nested-payload
 *       closure edge. Mirrors Kotlin's {@code ObjectField} arm.</li>
 *   <li>Otherwise — fall back to {@link SpringTypeMapper#javaTypeName(MetaField)}.</li>
 * </ul>
 *
 * <p>Class-naming convention: the emitted record name is
 * {@code <PascalCaseTemplateShortName>Payload}. Templates declared in
 * {@code camelCase} (e.g. {@code adjudicationUser}) are capitalised before
 * appending {@code Payload}, matching Kotlin/C#/TS/Python and Java's own
 * PascalCase class-naming convention. Nested payload class names from the
 * {@code field.object} arm are capitalised the same way.
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

    // ADR-0044 backstop error code — a codegen-time (not loader) error, peer of the
    // render tier's ERR_VAR_NOT_ON_PAYLOAD. Declared LOCALLY (as in the TS/C#/Python
    // ports) rather than in the shared cross-port ledger; promoted to the ledger once
    // the coordinated follow-up lands, so no port reddens on a code it doesn't emit.
    public static final String ERR_PAYLOAD_NAME_COLLISION = "ERR_PAYLOAD_NAME_COLLISION";

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());

        // Dedupe nested payload classes emitted via declared `field.object
        // @objectRef` edges across all templates in this run. Key = FQN of the
        // source value-object the nested payload was generated from. Mirrors
        // KotlinPayloadGenerator.
        Set<String> emittedNestedFqns = new HashSet<>();

        // Stable name order — matches the other ports' deterministic emission.
        // Iterate ALL MetaTemplate subtypes (prompt / output / toolcall);
        // every template with a @payloadRef gets a payload record.
        // ADR-0039: root-scan discipline — resolving children accessor.
        List<MetaTemplate> templates =
            new ArrayList<>(loader.getRoot().getChildren(MetaTemplate.class, true));
        templates.sort(Comparator.comparing(MetaTemplate::getName));

        // ADR-0044 — collision-scoped nested-payload record names, computed once as a
        // pure function of the loaded templates (order-independent). Keyed by VO FQN.
        Map<String, String> nameMap = computePayloadNameMap(templates, loader);

        for (MetaTemplate tmpl : templates) {
            emit(tmpl, loader, outRoot, emittedNestedFqns, nameMap);
        }
    }

    /**
     * ADR-0044 pass 1/2 — the run's nested-payload name map, keyed by value-object
     * FQN ({@link MetaObject#getName()}), scoped per OUTPUT PACKAGE. Java is a
     * one-record-per-file emitter, so its collision domain is the output (prompts)
     * package: two value-objects sharing a bare short name written into the same
     * package would clobber one {@code NotePayload.java}. A nested VO whose bare
     * short name is UNIQUE in its output package emits {@code <Short>Payload}
     * (byte-identical to pre-ADR-0044 output); a COLLISION emits every member under
     * its package-qualified derived name ({@code acme::alpha::Note} ->
     * {@code AcmeAlphaNotePayload}). A still-colliding derived name fails loud with
     * {@link #ERR_PAYLOAD_NAME_COLLISION}. Pure function of the templates — never of
     * emission order.
     *
     * <p><b>public static</b> (promoted from {@code protected} instance) so
     * {@link SpringOutputParserGenerator} — a sibling generator consuming the SAME
     * {@code @payloadRef} closure — reuses this ONE name map rather than re-deriving
     * naming (#228: extract/output-parser tier collision-scoped naming).
     */
    public static Map<String, String> computePayloadNameMap(List<MetaTemplate> templates, MetaDataLoader loader) {
        // FQN -> output package (first reaching template in sorted order wins, matching
        // the run-wide dedupe below). The primary VO is template-named, so excluded.
        Map<String, String> voOutPkg = new LinkedHashMap<>();
        List<String> orderedFqns = new ArrayList<>();
        for (MetaTemplate tmpl : templates) {
            MetaObject vo = resolveValueObject(loader, tmpl.getPayloadRef(),
                com.metaobjects.util.MetaDataUtil.findPackageForMetaData(tmpl));
            if (vo == null) continue;
            String nestedPkg = SpringNaming.promptsPackage(SpringNaming.splitFqn(tmpl.getName())[0]);
            Set<String> seen = new HashSet<>();
            seen.add(vo.getName()); // primary is template-named — outside the VO-name collision domain
            collectNestedClosure(vo, loader, nestedPkg, voOutPkg, orderedFqns, seen);
        }
        // Group by (output package, bare short name).
        Map<String, List<String>> byPkgShort = new LinkedHashMap<>();
        for (String fqn : orderedFqns) {
            String key = voOutPkg.get(fqn) + "\0" + SpringNaming.splitFqn(fqn)[1];
            byPkgShort.computeIfAbsent(key, k -> new ArrayList<>()).add(fqn);
        }
        Map<String, String> nameMap = new LinkedHashMap<>();
        for (List<String> fqns : byPkgShort.values()) {
            if (fqns.size() == 1) {
                String fqn = fqns.get(0);
                nameMap.put(fqn, SpringNaming.payloadName(SpringNaming.splitFqn(fqn)[1]));
            } else {
                for (String fqn : fqns) {
                    String[] sp = SpringNaming.splitFqn(fqn);
                    nameMap.put(fqn, SpringNaming.payloadName(packageQualifiedName(sp[0], sp[1])));
                }
            }
        }
        // Backstop — per output package, two DISTINCT FQNs deriving the same record
        // name (e.g. acme::alpha and acmeAlpha both fold to AcmeAlpha). Sorted so the
        // named pair (and whether any collision fires) is order-independent.
        Map<String, String> ownerByPkgName = new HashMap<>();
        List<String> sortedFqns = new ArrayList<>(nameMap.keySet());
        Collections.sort(sortedFqns);
        for (String fqn : sortedFqns) {
            String pkgName = voOutPkg.get(fqn) + "\0" + nameMap.get(fqn);
            String prev = ownerByPkgName.putIfAbsent(pkgName, fqn);
            if (prev != null && !prev.equals(fqn)) {
                throw new GeneratorException(ERR_PAYLOAD_NAME_COLLISION
                    + ": payload record name collision: \"" + nameMap.get(fqn)
                    + "\" derives from both \"" + prev + "\" and \"" + fqn
                    + "\" — rename one value-object or move it to a package that derives a distinct name");
            }
        }
        return nameMap;
    }

    /**
     * ADR-0044 pass 1 — walk {@code vo}'s transitive nested-payload closure (declared
     * {@code field.object @objectRef} edges ONLY, #270), assigning each not-yet-seen
     * target VO to {@code outPkg} (first reaching template wins) and recording it in
     * {@code orderedFqns}. {@code seen} is seeded with the primary VO's FQN and
     * doubles as the cycle guard.
     *
     * <p><b>public static</b> (promoted from {@code protected} instance, #228) — see
     * {@link #computePayloadNameMap}.
     */
    public static void collectNestedClosure(MetaObject vo,
                                        MetaDataLoader loader,
                                        String outPkg,
                                        Map<String, String> voOutPkg,
                                        List<String> orderedFqns,
                                        Set<String> seen) {
        for (MetaField<?> field : vo.getMetaFields()) {
            MetaObject target = nestedTargetOf(field, loader);
            if (target == null) continue;
            String fqn = target.getName();
            if (!seen.add(fqn)) continue;
            if (!voOutPkg.containsKey(fqn)) {
                voOutPkg.put(fqn, outPkg);
                orderedFqns.add(fqn);
            }
            collectNestedClosure(target, loader, outPkg, voOutPkg, orderedFqns, seen);
        }
    }

    /**
     * The nested-payload target VO a {@code field} contributes to the closure, or
     * {@code null} when it contributes no nested record. The ONLY closure edge is a
     * declared {@code field.object @objectRef} whose target is an
     * {@code object.value} (#270 — an {@code origin.*} child never contributes an
     * edge; a non-object field contributes nothing). Mirrors the resolution in
     * {@link #resolveObjectFieldType} EXACTLY, so the closure walk and the emission
     * walk agree on the target set.
     *
     * <p><b>public static</b> (promoted from {@code protected} instance, #228) — see
     * {@link #computePayloadNameMap}. {@code loader} is retained for the #228 public
     * signature; the declared edge resolves through the loader-bound
     * {@link ObjectField#getObjectRef()} and no longer reads it directly.
     */
    public static MetaObject nestedTargetOf(MetaField<?> field, MetaDataLoader loader) {
        if (field instanceof ObjectField of) {
            MetaObject target = of.getObjectRef();
            if (target == null || !MetaObject.SUBTYPE_VALUE.equals(target.getSubType())) return null;
            return target;
        }
        return null;
    }

    /**
     * ADR-0044 — PascalCase each dotted segment of {@code javaPkg} (already
     * {@code ::}->{@code .} converted by {@link SpringNaming#splitFqn}), concatenate,
     * append the bare {@code shortName} ({@code "acme.alpha"} + {@code "Note"} ->
     * {@code "AcmeAlphaNote"}). A root-level (empty-package) node keeps its bare name.
     *
     * <p><b>public static</b> (widened from package-private-visible {@code protected
     * static}, #228) — see {@link #computePayloadNameMap}.
     */
    public static String packageQualifiedName(String javaPkg, String shortName) {
        if (javaPkg == null || javaPkg.isEmpty()) return shortName;
        StringBuilder sb = new StringBuilder();
        for (String seg : javaPkg.split("\\.")) {
            if (!seg.isEmpty()) sb.append(Character.toUpperCase(seg.charAt(0))).append(seg.substring(1));
        }
        return sb.append(shortName).toString();
    }

    /**
     * True iff this generator emits a payload record for {@code node}: the node is
     * a {@code template.*} ({@code prompt} / {@code output} / {@code toolcall})
     * carrying a {@code @payloadRef} that resolves (against {@code loader}) to an
     * {@code object.value}. Extracted verbatim from the per-template
     * {@link #emit(MetaTemplate, MetaDataLoader, Path, Set)} skip guard so the
     * api-docs IR builder reuses the same decision.
     */
    public static boolean appliesTo(MetaData node, MetaDataLoader loader) {
        if (!(node instanceof MetaTemplate template)) return false;
        String payloadRef = template.getPayloadRef();
        if (payloadRef == null || payloadRef.isEmpty()) return false;
        return resolveValueObject(loader, payloadRef,
            com.metaobjects.util.MetaDataUtil.findPackageForMetaData(template)) != null;
    }

    protected void emit(MetaTemplate template, MetaDataLoader loader, Path outRoot,
                      Set<String> emittedNestedFqns, Map<String, String> nameMap) {
        if (!appliesTo(template, loader)) {
            return; // missing @payloadRef, or not a VO — same contract as Kotlin / C# / Python
        }
        MetaObject payloadVo = resolveValueObject(loader, template.getPayloadRef(),
            com.metaobjects.util.MetaDataUtil.findPackageForMetaData(template));

        String[] split = SpringNaming.splitFqn(template.getName());
        String templatePkg = split[0];
        String templateShort = split[1];
        String outPkg = SpringNaming.promptsPackage(templatePkg);
        String recordName = SpringNaming.payloadName(templateShort);

        emitPayloadRecord(
            outPkg,
            recordName,
            "GENERATED — payload for template `" + template.getName() + "`. "
                + "Do not hand-edit; regenerated from metadata.",
            payloadVo,
            loader,
            outRoot,
            emittedNestedFqns,
            nameMap);
    }

    /**
     * Emit a single Java record for {@code voObject} into
     * {@code <outPkg>.<recordName>}, resolving each component's type via
     * {@link #resolveFieldType}. When a field is a declared {@code field.object
     * @objectRef} to an {@code object.value}, recursively emits its nested payload
     * record first (per-run deduped via {@code emittedNestedFqns}).
     */
    protected void emitPayloadRecord(String outPkg,
                                   String recordName,
                                   String banner,
                                   MetaObject voObject,
                                   MetaDataLoader loader,
                                   Path outRoot,
                                   Set<String> emittedNestedFqns,
                                   Map<String, String> nameMap) {
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
        // Nested `public enum <Name> { <members> }` declarations for this record's enum fields,
        // deduped by enum-type name (two fields extending one abstract enum emit ONE decl). These
        // are emitted INSIDE the record body so a strict component can reference the value-
        // constrained type (the typed-enums payload-VO change).
        List<String> enumDecls = collectEnumDecls(voObject);

        Iterator<MetaField> it = voObject.getMetaFields().iterator();
        while (it.hasNext()) {
            MetaField field = it.next();
            String type = resolveFieldType(field, voObject, loader, outPkg, outRoot, emittedNestedFqns, nameMap);
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
        if (helpers.isEmpty() && enumDecls.isEmpty()) {
            src.append(") {}\n");
        } else {
            src.append(") {\n");
            // Nested enum types first (a strict component above already references them).
            for (String decl : enumDecls) {
                src.append("    ").append(decl).append('\n');
            }
            for (String[] h : helpers) {
                // Shared naming rule (render.PayloadAccessors) — the static template
                // drift check (render.Verify) accepts {{#has<Field>}} sections by the
                // SAME rule, so the emitted method name and the accepted section name
                // can never drift apart.
                String methodName = com.metaobjects.render.PayloadAccessors.hasAccessorName(h[0]);
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
     * Resolve the Java type expression of a single payload-VO field from its
     * DECLARATION only (#270): {@code field.<subType>} + {@code isArray} +
     * {@code @objectRef}. Any {@code origin.*} child the field carries is IGNORED —
     * the field types exactly as if the origin child were absent (matching the
     * origin-blind TS / C# emitters and the converged Kotlin / Python ports).
     * Precedence: (1) {@code field.enum} types as the generated nested enum;
     * (2) a {@code field.object} routes through the nested-payload emission arm;
     * (3) otherwise the scalar fallback via {@link SpringTypeMapper#javaTypeName}.
     */
    public String resolveFieldType(MetaField<?> field,
                                    MetaObject owner,
                                    MetaDataLoader loader,
                                    String nestedPkg,
                                    Path outRoot,
                                    Set<String> emittedNestedFqns,
                                    Map<String, String> nameMap) {
        // field.enum (scalar or array): type the STRICT payload component as the generated
        // Java enum nested in this record. The enum name is unqualified here because the record
        // references its own nested type; the sibling parser/mapper qualifies it as
        // `<Record>.<Enum>`. Single → `<Enum>`; array → `java.util.List<<Enum>>`. The lenient
        // mirror + engine schema stay String (SpringTypeMapper.javaTypeName). The nested enum
        // DECLARATION is emitted by emitPayloadRecord (deduped by name).
        if (field instanceof EnumField) {
            return SpringTypeMapper.payloadJavaTypeName(field, owner, "");
        }
        if (field instanceof ObjectField of) {
            return resolveObjectFieldType(of, loader, nestedPkg, outRoot, emittedNestedFqns, nameMap);
        }
        return SpringTypeMapper.javaTypeName(field);
    }

    /**
     * Declared {@code field.object @objectRef}: recursively emit
     * {@code <CapitalizedTargetShortName>Payload} for the referenced VO, and
     * return that type — or {@code java.util.List<TargetPayload>} when
     * {@code isArray: true}. Mirrors Kotlin's {@code ObjectField} arm in
     * {@code KotlinPayloadGenerator.resolveFieldType}.
     */
    protected String resolveObjectFieldType(ObjectField field,
                                          MetaDataLoader loader,
                                          String nestedPkg,
                                          Path outRoot,
                                          Set<String> emittedNestedFqns,
                                          Map<String, String> nameMap) {
        MetaObject target = field.getObjectRef();
        if (target == null) return SpringTypeMapper.javaTypeName(field);
        if (!MetaObject.SUBTYPE_VALUE.equals(target.getSubType())) {
            // Same payload-VO contract as @payloadRef — nested payloads must
            // themselves be object.value. Loader validation normally catches
            // this; defensive fallback to scalar type.
            return SpringTypeMapper.javaTypeName(field);
        }
        // ADR-0039: resolving array-ness (isArray() is the own-only native flag).
        return emitNestedAndReturnType(target, loader, nestedPkg, outRoot, emittedNestedFqns, field.isArrayType(), nameMap);
    }

    /**
     * Nested-payload emit path used by {@link #resolveObjectFieldType} (single or
     * list, depending on {@code asList}). Emits the record at most once per run via
     * the {@code emittedNestedFqns} dedupe set, and returns the type expression
     * to use as the parent field's component type. Returns
     * {@code java.util.List<TargetPayload>} (fully-qualified to sidestep any
     * potential {@code List} import collision in generated code) when
     * {@code asList} is true, else just {@code TargetPayload}.
     */
    protected String emitNestedAndReturnType(MetaObject target,
                                           MetaDataLoader loader,
                                           String nestedPkg,
                                           Path outRoot,
                                           Set<String> emittedNestedFqns,
                                           boolean asList,
                                           Map<String, String> nameMap) {
        // ADR-0044 — the record name (declaration, file name, and this reference)
        // comes from the collision-scoped name map (bare when unique in the output
        // package, package-qualified on a cross-package short-name collision). The
        // bare fallback guards callers that emit without a precomputed map (api-docs).
        String nestedRecord = nameMap.getOrDefault(
            target.getName(), SpringNaming.payloadName(SpringNaming.splitFqn(target.getName())[1]));
        if (emittedNestedFqns.add(target.getName())) {
            emitPayloadRecord(
                nestedPkg,
                nestedRecord,
                "GENERATED — nested payload for `" + target.getName() + "`. "
                    + "Do not hand-edit; regenerated from metadata.",
                target,
                loader,
                outRoot,
                emittedNestedFqns,
                nameMap);
        }
        return asList ? "java.util.List<" + nestedRecord + ">" : nestedRecord;
    }

    // -------------------------------------------------------------------------
    // Local helpers (intentionally not in SpringNaming — payload-specific. If a
    // second generator needs them, lift them up the same way KotlinGenUtil holds
    // its share.)
    // -------------------------------------------------------------------------

    /**
     * Collect the nested {@code public enum <Name> { <members> }} declarations for the enum
     * fields of {@code vo}, deduped by enum-type name (two fields extending one abstract enum
     * emit ONE declaration). Members are the EFFECTIVE {@code @values}, verbatim. Mirrors the
     * C# {@code PayloadCodegen.CollectEnumDecls} pattern; the type name + super-resolution come
     * from {@link SpringTypeMapper}.
     */
    private static List<String> collectEnumDecls(MetaObject vo) {
        Set<String> seen = new HashSet<>();
        List<String> decls = new ArrayList<>();
        for (MetaField<?> field : vo.getMetaFields()) {
            if (!(field instanceof EnumField ef)) continue;
            List<String> values = SpringTypeMapper.effectiveEnumValues(ef);
            if (values.isEmpty()) continue;
            String typeName = SpringTypeMapper.enumTypeName(vo, ef);
            if (!seen.add(typeName)) continue; // dedup shared abstract-enum types
            decls.add("public enum " + typeName + " { " + String.join(", ", values) + " }");
        }
        return decls;
    }

    /**
     * Resolve a {@link MetaObject} (entity OR value) by exact FQN or by short
     * name. Returns {@code null} when neither matches.
     *
     * <p>#270 stranded this helper — its last in-repo callers were the deleted
     * {@code origin.*} dotted-ref resolvers — but it is KEPT: {@code protected}
     * members of this deliberately-extensible generator are adopter subclass API,
     * and removing one is an API break out of proportion to the cleanup (the same
     * keep-and-record policy as Kotlin's {@code KotlinGenUtil.splitDottedRef}).
     * Recorded in this module's {@code KNOWN_GAPS.md}; prune in a future MAJOR.
     * NOTE: this is the bare-tail/first-match resolver — never use it for
     * {@code @payloadRef} (that ref kind is ADR-0042 package-local; see
     * {@link #resolveValueObject}).
     */
    protected static MetaObject resolveObjectByShortOrFqn(MetaDataLoader loader, String ref) {
        for (MetaObject obj : loader.getMetaObjects()) {
            if (obj.getName().equals(ref) || shortName(obj.getName()).equals(ref)) {
                return obj;
            }
        }
        return null;
    }

    /** Trailing segment after the last {@code ::}, or the whole input when no separator. */
    private static String shortName(String fqn) {
        int idx = fqn.lastIndexOf("::");
        return idx < 0 ? fqn : fqn.substring(idx + 2);
    }

    /**
     * Resolve {@code @payloadRef} to its {@code object.value} target (rejects entities)
     * under the ADR-0042 package-local contract (#228): a bare ref resolves in
     * {@code referrerPkg} first, else root-level; an FQN ref matches exactly. Distinct
     * from the bare-tail {@link #resolveObjectByShortOrFqn} — {@code @payloadRef} is
     * the one every port's canonical resolver gates, matching the loader's own
     * {@code ValidationPhase} validation of the same ref.
     */
    public static MetaObject resolveValueObject(MetaDataLoader loader, String ref, String referrerPkg) {
        return SpringNaming.resolveValueObjectRef(loader, ref, referrerPkg);
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
    public static String hasHelperBody(String type, String name) {
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
        return SpringNaming.payloadName(SpringNaming.splitFqn(md.getName())[1]) + ".java";
    }
}
