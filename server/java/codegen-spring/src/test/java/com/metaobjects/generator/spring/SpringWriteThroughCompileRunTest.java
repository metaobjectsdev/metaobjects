package com.metaobjects.generator.spring;

import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Write-through entity read-view codegen guard for the Java port (FR-024 §7, #214).
 *
 * <p>A <b>write-through entity</b> declares BOTH a writable {@code source.rdb}
 * ({@code @kind: table}) and a read-only replica {@code source.rdb}
 * ({@code @role: replica @kind: view}) plus DERIVED fields (a {@code field.*}
 * carrying an {@code origin.*} child). Mirrors the TypeScript reference
 * ({@code b4eee456}); the Java codegen is SQL-free (ADR-0015), so the read-half
 * contract here is: the read {@code <Entity>Dto} CARRIES the derived field, the
 * write {@code <Entity>Patch} EXCLUDES it, and — because a write-through entity is
 * writable — the controller / repository / filter-allowlist ARE emitted (unlike a
 * read-only projection). "Reads route to the view / writes to the table" is the
 * consumer's {@code <Entity>Repository} implementation contract (no generated SQL).</p>
 *
 * <p>The fixture is the canonical {@code Customer} + write-through {@code Order}
 * (replica view {@code v_order_with_customer}, derived {@code customerName}
 * passthrough from {@code Customer.name} via the {@code customer} join) — the same
 * shape the TS unit test pins.</p>
 */
public class SpringWriteThroughCompileRunTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /** Canonical write-through fixture — table source declared FIRST. */
    private static final String WRITE_THROUGH_FIXTURE = """
        {
          "metadata.root": { "package": "acme::sales", "children": [
            { "object.entity": { "name": "Customer", "children": [
                { "source.rdb": { "@table": "customers" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Order", "children": [
                { "source.rdb": { "@role": "primary", "@table": "orders" } },
                { "source.rdb": { "@role": "replica", "@kind": "view", "@view": "v_order_with_customer" } },
                { "field.long":   { "name": "id" } },
                { "field.long":   { "name": "customerId", "@required": true } },
                { "field.string": { "name": "customerName", "children": [
                    { "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } } ] } },
                { "relationship.association": { "name": "customer", "@objectRef": "Customer", "@cardinality": "one" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                { "identity.reference": { "name": "ref_customer", "@fields": ["customerId"], "@references": "Customer" } }
            ] } }
          ] }
        }
        """;

    /** Same as above but with the replica VIEW source declared BEFORE the table — guards
     *  that write-through detection / write-surface inclusion is source-order-independent
     *  (the pre-#214 {@code firstRdbSource}-based gate wrongly skipped a view-first entity). */
    private static final String WRITE_THROUGH_VIEW_FIRST_FIXTURE = """
        {
          "metadata.root": { "package": "acme::sales", "children": [
            { "object.entity": { "name": "Customer", "children": [
                { "source.rdb": { "@table": "customers" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Order", "children": [
                { "source.rdb": { "@role": "replica", "@kind": "view", "@view": "v_order_with_customer" } },
                { "source.rdb": { "@role": "primary", "@table": "orders" } },
                { "field.long":   { "name": "id" } },
                { "field.long":   { "name": "customerId", "@required": true } },
                { "field.string": { "name": "customerName", "children": [
                    { "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } } ] } },
                { "relationship.association": { "name": "customer", "@objectRef": "Customer", "@cardinality": "one" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                { "identity.reference": { "name": "ref_customer", "@fields": ["customerId"], "@references": "Customer" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void writeThroughReadDtoCarriesDerived_patchExcludesDerived_writeSurfacesEmit() throws Exception {
        Path gen = tmp.newFolder("gen-wt").toPath();
        Path ws  = tmp.newFolder("ws-wt").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "wt", WRITE_THROUGH_FIXTURE);

        MetaObject order = loader.getMetaObjectByName("acme::sales::Order");
        assertNotNull("write-through Order must load", order);

        // --- predicates ---
        assertTrue("Order owns a table + a replica view → write-through", order.isWriteThrough());
        assertFalse("plain Customer is not write-through",
                loader.getMetaObjectByName("acme::sales::Customer").isWriteThrough());
        MetaField customerName = order.getMetaField("customerName");
        MetaField customerId = order.getMetaField("customerId");
        assertTrue("customerName carries origin.passthrough → derived", customerName.isDerived());
        assertFalse("customerId is stored → not derived", customerId.isDerived());

        // --- write-through IS writable → every write surface emits (unlike a projection) ---
        assertTrue("read DTO applies", SpringDtoGenerator.appliesTo(order));
        assertTrue("write-through has a repository", SpringRepositoryGenerator.appliesTo(order));
        assertTrue("write-through has a controller", SpringControllerGenerator.appliesTo(order));
        assertTrue("write-through has a filter allowlist", SpringFilterAllowlistGenerator.appliesTo(order));

        // --- generate the DTO + Patch (SpringDtoGenerator emits both) ---
        runGenerator(new SpringDtoGenerator(), loader, gen);

        // read DTO carries the derived field; write Patch excludes it.
        Path dto = gen.resolve("acme/sales/OrderDto.java");
        Path patch = gen.resolve("acme/sales/OrderPatch.java");
        assertTrue("expected OrderDto.java", Files.exists(dto));
        assertTrue("expected OrderPatch.java", Files.exists(patch));
        String dtoSrc = Files.readString(dto);
        String patchSrc = Files.readString(patch);

        assertTrue("read DTO must carry the derived `customerName`; saw:\n" + dtoSrc,
                dtoSrc.contains("customerName"));
        assertFalse("write Patch must NOT carry the derived `customerName`; saw:\n" + patchSrc,
                patchSrc.contains("customerName"));
        // the stored writable field is present in both.
        assertTrue("read DTO carries the stored customerId", dtoSrc.contains("customerId"));
        assertTrue("write Patch carries the stored customerId", patchSrc.contains("customerId"));

        // --- strongest proof: the DTO + Patch compile (jakarta.validation + Jackson are on the
        //     test classpath; the Spring-Web controller/repository are validated by appliesTo above
        //     + file emission below, and compiled with Spring only in the api-contract integration lane) ---
        compile(gen);

        // --- concrete emission: the write surfaces actually write their files for a write-through
        //     entity (not just appliesTo=true) — a projection would emit none of these ---
        Path genWrite = tmp.newFolder("gen-wt-write").toPath();
        runGenerator(new SpringRepositoryGenerator(), loader, genWrite);
        runGenerator(new SpringControllerGenerator(), loader, genWrite);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, genWrite);
        assertTrue("write-through emits a repository",
                Files.exists(genWrite.resolve("acme/sales/OrderRepository.java")));
        assertTrue("write-through emits a controller",
                Files.exists(genWrite.resolve("acme/sales/OrderController.java")));
        assertTrue("write-through emits a filter allowlist",
                Files.exists(genWrite.resolve("acme/sales/OrderFilterAllowlist.java")));
    }

    /** A write-through entity carrying a guaranteed-non-null {@code origin.aggregate @agg:any}
     *  derived field ({@code anyError}). On a read-only PROJECTION such a field is {@code @NotNull}
     *  (#195), but on a WRITE-THROUGH entity the shared read/create DTO must NOT carry {@code @NotNull}
     *  for it — otherwise the generated POST-create ({@code validator.validate(dto)}) would 400 a
     *  legitimate create that omits the view-computed field. */
    private static final String WRITE_THROUGH_AGGREGATE_FIXTURE = """
        {
          "metadata.root": { "package": "acme::sessions", "children": [
            { "object.entity": { "name": "Turn", "children": [
                { "source.rdb": { "@table": "turns" } },
                { "field.long": { "name": "id" } },
                { "field.boolean": { "name": "success" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Session", "children": [
                { "source.rdb": { "@role": "primary", "@table": "sessions" } },
                { "source.rdb": { "@role": "replica", "@kind": "view", "@view": "v_session" } },
                { "field.long": { "name": "id" } },
                { "field.boolean": { "name": "anyError", "children": [
                    { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { "success": false } } } ] } },
                { "relationship.association": { "name": "turns", "@objectRef": "Turn", "@cardinality": "many" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void writeThroughAggregateDerivedFieldIsNotNotNullOnTheSharedCreateDto() throws Exception {
        Path gen = tmp.newFolder("gen-agg").toPath();
        Path ws  = tmp.newFolder("ws-agg").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "agg", WRITE_THROUGH_AGGREGATE_FIXTURE);

        MetaObject session = loader.getMetaObjectByName("acme::sessions::Session");
        assertNotNull("write-through Session must load", session);
        assertTrue("Session is write-through", session.isWriteThrough());
        assertTrue("anyError is derived", session.getMetaField("anyError").isDerived());

        runGenerator(new SpringDtoGenerator(), loader, gen);
        String dtoSrc = Files.readString(gen.resolve("acme/sessions/SessionDto.java"));
        String patchSrc = Files.readString(gen.resolve("acme/sessions/SessionPatch.java"));

        // read DTO carries the derived field, but WITHOUT @NotNull (so POST-create can omit it).
        assertTrue("read DTO carries the derived anyError; saw:\n" + dtoSrc, dtoSrc.contains("anyError"));
        assertFalse("write-through aggregate-derived field must NOT be @NotNull on the shared "
                + "read/create DTO (POST-create would else 400 a body omitting it); saw:\n" + dtoSrc,
                componentIsNotNull(dtoSrc, "anyError"));
        // and it is excluded from the write Patch entirely.
        assertFalse("write Patch must exclude the derived anyError; saw:\n" + patchSrc,
                patchSrc.contains("anyError"));

        compile(gen);
    }

    /** True iff the DTO record component line for {@code fieldName} carries {@code @NotNull}. */
    private static boolean componentIsNotNull(String src, String fieldName) {
        for (String line : src.split("\n")) {
            String t = line.trim();
            if (t.equals(fieldName) || t.equals(fieldName + ",")
                    || t.endsWith(" " + fieldName) || t.endsWith(" " + fieldName + ",")) {
                return t.contains("@NotNull");
            }
        }
        throw new AssertionError("no DTO component line for field '" + fieldName + "' in:\n" + src);
    }

    @Test
    public void writeThroughDetectionIsSourceOrderIndependent() throws Exception {
        Path ws = tmp.newFolder("ws-vf").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "vf", WRITE_THROUGH_VIEW_FIRST_FIXTURE);
        MetaObject order = loader.getMetaObjectByName("acme::sales::Order");
        assertNotNull("view-first write-through Order must load", order);

        assertTrue("view-first Order is still write-through", order.isWriteThrough());
        // The pre-#214 gate keyed on the FIRST source (the view) and wrongly skipped these.
        assertTrue("view-first write-through still gets a repository",
                SpringRepositoryGenerator.appliesTo(order));
        assertTrue("view-first write-through still gets a controller",
                SpringControllerGenerator.appliesTo(order));
        assertTrue("view-first write-through still gets a filter allowlist",
                SpringFilterAllowlistGenerator.appliesTo(order));
    }

    /** Run one generator into {@code outDir}. */
    private static void runGenerator(
            com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?> generator,
            MetaDataLoader loader, Path outDir) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        generator.setArgs(args);
        generator.execute(loader);
    }

    /**
     * Compile every generated {@code .java} under {@code gen} with the in-process JDK
     * compiler ({@code render}/{@code om} are on the test classpath). Fails with the
     * diagnostics + source dump if compilation does not succeed.
     */
    private void compile(Path gen) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + gen, sources.isEmpty());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes-" + gen.getFileName()).toPath();
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", cp, "-d", classes.toString());

        boolean ok = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated write-through surface failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
                if (d.getSource() != null) {
                    sb.append("    at ").append(d.getSource().getName())
                      .append(':').append(d.getLineNumber()).append('\n');
                }
            }
            for (File f : sources) {
                sb.append("\n=== ").append(f.getName()).append(" ===\n");
                sb.append(Files.readString(f.toPath())).append('\n');
            }
            fail(sb.toString());
        }
    }
}
