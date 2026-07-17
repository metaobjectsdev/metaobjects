package com.metaobjects.generator.spring;

import static com.metaobjects.generator.spring.SpringNaming.firstRdbSource;

import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.MetaSource;
import com.metaobjects.source.RdbSource;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Generator: one {@code <Entity>FilterAllowlist.java} per writable
 * {@code object.entity} ({@code source.rdb @kind="table"}) that emits a
 * static allowlist (per the cross-port FR-009 spec). The allowlist contains
 * the set of filterable field names plus the operator-set permitted per
 * field (gated by field subtype).
 *
 * <p>Authoring contract: only fields with {@code @filterable: true} appear
 * in the allowlist. If no field is marked filterable the file is still
 * emitted (with empty constants) so the generated controller can
 * unconditionally delegate to it without conditional codegen branching.</p>
 *
 * <p>Operators-per-subtype mapping (FR-009 §5, identical across ports):</p>
 * <ul>
 *   <li>{@code string} / {@code enum} → {@code eq, ne, in, like, isNull}</li>
 *   <li>{@code uuid} → {@code eq, ne, in, isNull} (no {@code like} — not a substring type, no ordering)</li>
 *   <li>{@code int / long / short / byte / float / double / decimal /
 *       currency / date / timestamp / time} →
 *       {@code eq, ne, gt, gte, lt, lte, in, isNull}</li>
 *   <li>{@code boolean} → {@code eq, isNull}</li>
 * </ul>
 *
 * <p>{@link ObjectField} children are skipped — they have no SQL column
 * surface that filters can target.</p>
 *
 * <p>Args:</p>
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringFilterAllowlistGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    /** Metadata attribute marking a field as filterable in the generated allowlist. */
    static final String ATTR_FILTERABLE = "filterable";

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());
        for (MetaObject entity : loader.getMetaObjects()) {
            if (TphPlan.isTphSubtype(entity)) continue; // folded into the base — no own allowlist
            if (!appliesTo(entity)) continue;
            emit(entity, outRoot, loader);
        }
    }

    /**
     * True iff this generator emits a filter allowlist for {@code entity}: a
     * concrete (non-abstract) {@code object.entity} whose first {@code source.rdb}
     * child is {@code @kind="table"} (writable). Same table guard as
     * {@link SpringControllerGenerator#appliesTo(MetaObject)} — the controller's
     * list handler reads this allowlist. Extracted verbatim from the
     * {@link #execute(MetaDataLoader)} per-node guard.
     */
    public static boolean appliesTo(MetaObject entity) {
        if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())) return false;
        if (com.metaobjects.generator.util.GeneratorUtil.isAbstract(entity)) return false;
        RdbSource sourceRdb = firstRdbSource(entity);
        if (sourceRdb == null) return false;
        // FR-024 §7 (#214): a write-through entity read-view owns BOTH a writable table
        // source and a read-only replica view source — it is writable and MUST emit its
        // write surfaces regardless of source declaration order (firstRdbSource is
        // order-dependent). A vanilla table entity emits; a projection (read-only-only) skips.
        return entity.isWriteThrough() || MetaSource.KIND_TABLE.equals(sourceRdb.getEffectiveKind());
    }

    /**
     * Build the {@code (fieldName → opSet)} map for {@code entity}. Only
     * fields with {@code @filterable: true} are included; subtypes outside
     * the FR-009 vocabulary collapse to the empty op-set (defensive — the
     * allowlist becomes an effective "field is unknown" gate).
     */
    static Map<String, Set<String>> computeFilterableOps(MetaObject entity) {
        return computeFilterableOps(entity.getMetaFields());
    }

    /**
     * {@link #computeFilterableOps(MetaObject)} over an explicit field list — used for a TPH base,
     * whose allowlist is the UNION of the base's own + every subtype-only filterable column (so the
     * polymorphic + per-subtype lists can filter on subtype columns, matching the Python/TS lanes).
     */
    static Map<String, Set<String>> computeFilterableOps(Iterable<MetaField> fields) {
        Map<String, Set<String>> out = new LinkedHashMap<>();
        for (MetaField field : fields) {
            if (field instanceof ObjectField) continue;
            if (!isFilterable(field)) continue;
            Set<String> ops = opsForSubtype(field.getSubType());
            if (ops.isEmpty()) continue;
            out.putIfAbsent(field.getName(), ops); // dedup base/subtype column names
        }
        return out;
    }

    /** True iff {@code field} carries {@code @filterable: true} as a metadata attribute. */
    protected static boolean isFilterable(MetaField field) {
        if (!field.hasMetaAttr(ATTR_FILTERABLE)) return false;
        Object raw = field.getMetaAttr(ATTR_FILTERABLE).getValue();
        if (raw instanceof Boolean b) return b;
        return Boolean.parseBoolean(String.valueOf(raw));
    }

    private static Set<String> opsForSubtype(String subType) {
        // Single source of truth — com.metaobjects.query.FilterOps (the same
        // band the loader's validation path reads). Returns a canonical-ordered
        // set so the emitted source is stable; an unbanded subtype → empty set,
        // which computeFilterableOps drops.
        return com.metaobjects.query.FilterOps.opsForSubType(subType);
    }

    protected void emit(MetaObject entity, Path outRoot, MetaDataLoader loader) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String className = SpringNaming.filterAllowlistName(shortName);

        // FR-017 TPH: a discriminator base's allowlist unions its subtype-only filterable columns,
        // but EXCLUDES (a) the discriminator — it's addressable via the per-subtype route segment
        // (/<base>/<value>), not a free-form filter column — and (b) decimal columns, which are
        // outside the cross-port HTTP filter/value contract (decimal wire formatting differs per
        // port, so a portable operand can't be guaranteed). Keeps the Java + Kotlin filter surface
        // identical. Other columns (id/string/int/bool/date/...) filter via the FR-009 pipeline.
        Map<String, Set<String>> opsByField;
        if (TphPlan.isTphBase(entity, loader)) {
            String disc = TphPlan.planFor(entity, loader).discriminatorField();
            java.util.List<MetaField> union = new java.util.ArrayList<>();
            entity.getMetaFields().forEach(union::add);
            union.addAll(TphPlan.collectSubtypeFields(entity, loader));
            union.removeIf(f -> f.getName().equals(disc) || f instanceof com.metaobjects.field.DecimalField);
            opsByField = computeFilterableOps(union);
        } else {
            opsByField = computeFilterableOps(entity);
        }

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("import java.util.Map;\n");
        src.append("import java.util.Set;\n\n");
        src.append("/**\n");
        src.append(" * GENERATED — per-entity FR-009 filter allowlist for ").append(shortName).append(".\n");
        src.append(" * FIELDS lists the filterable field names; OPS_BY_FIELD constrains the\n");
        src.append(" * operator vocabulary for each field by its subtype.\n");
        src.append(" */\n");
        src.append("public final class ").append(className).append(" {\n");

        // FIELDS — the field-name set. Use Set.of() for the empty + small cases.
        src.append("    public static final Set<String> FIELDS = Set.of(");
        boolean first = true;
        for (String f : opsByField.keySet()) {
            if (!first) src.append(", ");
            first = false;
            src.append('"').append(f).append('"');
        }
        src.append(");\n\n");

        // OPS_BY_FIELD — Map<field, Set<op>>. Empty map literal when no filterable fields.
        src.append("    public static final Map<String, Set<String>> OPS_BY_FIELD = ");
        if (opsByField.isEmpty()) {
            src.append("Map.of();\n");
        } else {
            src.append("Map.of(\n");
            int i = 0;
            for (Map.Entry<String, Set<String>> e : opsByField.entrySet()) {
                src.append("        \"").append(e.getKey()).append("\", Set.of(");
                boolean firstOp = true;
                for (String op : e.getValue()) {
                    if (!firstOp) src.append(", ");
                    firstOp = false;
                    src.append('"').append(op).append('"');
                }
                src.append(')');
                if (i++ < opsByField.size() - 1) src.append(',');
                src.append('\n');
            }
            src.append("    );\n");
        }

        // No instances — pure constants holder.
        src.append("\n    private ").append(className).append("() {}\n");
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(className + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + className + ".java for entity " + entity.getName() + ": " + e, e);
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
        return SpringNaming.splitFqn(md.getName())[1] + "FilterAllowlist.java";
    }
}
