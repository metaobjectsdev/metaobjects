package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;

import java.io.File;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Issue #203 — the generated Java CRUD honors {@code field.timestamp @autoSet: onCreate|onUpdate}.
 *
 * <p>Two lanes:</p>
 * <ul>
 *   <li>codegen goldens — the {@code <Entity>Dto} carries the {@code stampForInsert} /
 *       {@code stampForUpdate} / {@code insertPreserving} helpers, the {@code <Entity>Patch}
 *       carries {@code stampAutoSetOnUpdate()}, and the controller wires both; a NON-@autoSet
 *       entity stays byte-identical (no helpers, verbatim create);</li>
 *   <li>a compile-run of the emitted DTO + Patch proving the four contract behaviors: insert
 *       stamps BOTH columns to now() (created_at == updated_at); update bumps updated_at and
 *       preserves created_at; patch bumps updated_at; insertPreserving is verbatim.</li>
 * </ul>
 */
public class SpringAutoSetStampingTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String PKG = "acme.sub";

    /** Subscriber: createdAt @autoSet onCreate, updatedAt @autoSet onUpdate (the BaseEntity shape). */
    private static final String SUBSCRIBER = """
        { "metadata.root": { "package": "acme::sub", "children": [
          { "object.entity": { "name": "Subscriber", "children": [
            { "source.rdb":      { "@table": "subscribers" } },
            { "field.long":      { "name": "id" } },
            { "field.string":    { "name": "email", "@required": true } },
            { "field.timestamp": { "name": "createdAt", "@autoSet": "onCreate" } },
            { "field.timestamp": { "name": "updatedAt", "@autoSet": "onUpdate" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}}
        ]}}
        """;

    /** Same shape but NO @autoSet — the byte-identical control. */
    private static final String PLAIN = """
        { "metadata.root": { "package": "acme::sub", "children": [
          { "object.entity": { "name": "Note", "children": [
            { "source.rdb":      { "@table": "notes" } },
            { "field.long":      { "name": "id" } },
            { "field.string":    { "name": "body", "@required": true } },
            { "field.timestamp": { "name": "createdAt" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}}
        ]}}
        """;

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    // === lane 1: codegen goldens =============================================

    @Test
    public void dtoPatchAndControllerEmitAutoSetStamping() throws Exception {
        Path srcDir = tmp.newFolder("src").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("fx").toPath(), "sub", SUBSCRIBER);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringControllerGenerator(), loader, srcDir);

        String dto = Files.readString(srcDir.resolve("acme/sub/SubscriberDto.java"));
        String patch = Files.readString(srcDir.resolve("acme/sub/SubscriberPatch.java"));
        String ctrl = Files.readString(srcDir.resolve("acme/sub/SubscriberController.java"));

        // DTO: the three @autoSet stamping helpers.
        assertTrue("stampForInsert helper; saw:\n" + dto,
            dto.contains("public static SubscriberDto stampForInsert(SubscriberDto dto)"));
        assertTrue("stampForUpdate helper; saw:\n" + dto,
            dto.contains("public static SubscriberDto stampForUpdate(SubscriberDto dto)"));
        assertTrue("insertPreserving verbatim escape hatch; saw:\n" + dto,
            dto.contains("public static SubscriberDto insertPreserving(SubscriberDto dto) { return dto; }"));
        // stampForInsert stamps both columns from ONE shared now() local (created_at == updated_at).
        assertTrue("shared now() instant local; saw:\n" + dto,
            dto.contains("java.time.Instant __nowInstant = java.time.Instant.now();"));
        // @autoSet columns are server-owned → NOT caller-validated (no @NotNull), so a POST that
        // omits them does not 400. (email stays @NotNull.)
        assertFalse("createdAt must NOT carry @NotNull (server-owned); saw:\n" + dto,
            dto.contains("@NotNull java.time.Instant createdAt"));
        assertFalse("updatedAt must NOT carry @NotNull (server-owned); saw:\n" + dto,
            dto.contains("@NotNull java.time.Instant updatedAt"));

        // Patch: the onUpdate stamping hook (onUpdate only — createdAt is NOT put here).
        assertTrue("stampAutoSetOnUpdate hook; saw:\n" + patch,
            patch.contains("public void stampAutoSetOnUpdate()"));
        assertTrue("stampAutoSetOnUpdate bumps updatedAt; saw:\n" + patch,
            patch.contains("assigned.put(\"updatedAt\", java.time.Instant.now());"));
        assertFalse("createdAt (onCreate) must NOT be stamped on update; saw:\n" + patch,
            patch.contains("assigned.put(\"createdAt\""));

        // Controller: create stamps via the DTO helper; PATCH bumps updated_at.
        assertTrue("POST stamps on insert; saw:\n" + ctrl,
            ctrl.contains("repository.create(SubscriberDto.stampForInsert(dto))"));
        assertTrue("PATCH bumps updated_at; saw:\n" + ctrl,
            ctrl.contains("patch.stampAutoSetOnUpdate();"));
    }

    @Test
    public void nonAutoSetEntityStaysVerbatim() throws Exception {
        Path srcDir = tmp.newFolder("src").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("fx").toPath(), "note", PLAIN);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringControllerGenerator(), loader, srcDir);

        String dto = Files.readString(srcDir.resolve("acme/sub/NoteDto.java"));
        String patch = Files.readString(srcDir.resolve("acme/sub/NotePatch.java"));
        String ctrl = Files.readString(srcDir.resolve("acme/sub/NoteController.java"));

        assertFalse("no stamping helpers on a non-@autoSet DTO; saw:\n" + dto, dto.contains("stampForInsert"));
        assertFalse("no stampAutoSetOnUpdate on a non-@autoSet Patch; saw:\n" + patch,
            patch.contains("stampAutoSetOnUpdate"));
        assertTrue("verbatim create; saw:\n" + ctrl, ctrl.contains("repository.create(dto)"));
        assertFalse("no stamp call in a non-@autoSet controller; saw:\n" + ctrl,
            ctrl.contains("stampAutoSetOnUpdate"));
    }

    // === lane 2: compile + run ===============================================

    @Test
    public void compiledStampingHonorsTheContract() throws Exception {
        Path srcDir = tmp.newFolder("src").toPath();
        Path classesDir = tmp.newFolder("classes").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("fx").toPath(), "sub", SUBSCRIBER);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        compile(srcDir, classesDir);

        Instant before = Instant.now();
        Instant past = Instant.parse("2000-01-01T00:00:00Z");

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Class<?> dtoClass = cl.loadClass(PKG + ".SubscriberDto");
            // canonical constructor: (Long id, String email, Instant createdAt, Instant updatedAt)
            Object seed = dtoClass.getConstructor(Long.class, String.class, Instant.class, Instant.class)
                .newInstance(1L, "a@b.co", past, past);
            Method createdAt = dtoClass.getMethod("createdAt");
            Method updatedAt = dtoClass.getMethod("updatedAt");

            // insert: BOTH stamped to now(), and equal to each other (fresh row).
            Object inserted = dtoClass.getMethod("stampForInsert", dtoClass).invoke(null, seed);
            Instant ic = (Instant) createdAt.invoke(inserted);
            Instant iu = (Instant) updatedAt.invoke(inserted);
            assertFresh("insert.createdAt", ic, before);
            assertFresh("insert.updatedAt", iu, before);
            assertEquals("a fresh row's updated_at equals its created_at", ic, iu);

            // update(model): updated_at bumped, created_at PRESERVED (never rewritten).
            Object updated = dtoClass.getMethod("stampForUpdate", dtoClass).invoke(null, seed);
            assertEquals("update preserves created_at", past, createdAt.invoke(updated));
            assertFresh("update.updatedAt", (Instant) updatedAt.invoke(updated), before);

            // insertPreserving: verbatim (same instance, both timestamps untouched).
            Object preserved = dtoClass.getMethod("insertPreserving", dtoClass).invoke(null, seed);
            assertSame("insertPreserving is verbatim (same DTO)", seed, preserved);
            assertEquals("insertPreserving keeps created_at", past, createdAt.invoke(preserved));
            assertEquals("insertPreserving keeps updated_at", past, updatedAt.invoke(preserved));

            // patch: stampAutoSetOnUpdate() bumps updated_at even when the caller omits it.
            Class<?> patchClass = cl.loadClass(PKG + ".SubscriberPatch");
            JsonNode body = MAPPER.readTree("{\"email\":\"c@d.co\"}");
            Object patch = patchClass.getMethod("fromJson", JsonNode.class, ObjectMapper.class)
                .invoke(null, body, MAPPER);
            assertEquals("updatedAt absent before stamping", Boolean.FALSE,
                patchClass.getMethod("hasUpdatedAt").invoke(patch));
            patchClass.getMethod("stampAutoSetOnUpdate").invoke(patch);
            assertEquals("updatedAt present after stamping", Boolean.TRUE,
                patchClass.getMethod("hasUpdatedAt").invoke(patch));
            assertFresh("patch.updatedAt", (Instant) patchClass.getMethod("updatedAt").invoke(patch), before);
            // createdAt was never assigned by the patch (onCreate immutable on update).
            assertEquals("patch leaves createdAt untouched", Boolean.FALSE,
                patchClass.getMethod("hasCreatedAt").invoke(patch));
        }
    }

    /** A stamped instant is "now" — after the test-start marker and not the seeded past value. */
    private static void assertFresh(String label, Instant actual, Instant before) {
        assertNotNull(label + " stamped", actual);
        assertFalse(label + " must be after test start (" + before + "), was " + actual,
            actual.isBefore(before));
        assertFalse(label + " must be far in the future", actual.isAfter(Instant.now().plusSeconds(60)));
    }

    // === harness (mirrors SpringPatchEnumCompileRunTest) =====================

    private static void runGenerator(Object generator, MetaDataLoader loader, Path outDir) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).setArgs(args);
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).execute(loader);
    }

    private static void compile(Path srcDir, Path classesDir) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(srcDir)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertTrue("expected generated .java sources", !sources.isEmpty());
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK required — getSystemJavaCompiler() returned null", javac);
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        List<String> opts = List.of("-classpath", cp, "-d", classesDir.toString());
        boolean ok = javac.getTask(null, fm, diags, opts, null,
            fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
            }
            fail(sb.toString());
        }
    }
}
