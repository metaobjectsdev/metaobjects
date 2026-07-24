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

    /** FR-017 TPH base Auth carrying two @autoSet timestamps + one subtype BridgeAuth. */
    private static final String TPH_AUTOSET_JSON = """
        { "metadata.root": { "package": "acme::auth", "children": [
          { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb":       { "@table": "auths" } },
            { "field.long":       { "name": "id" } },
            { "field.enum":       { "name": "type", "@values": ["Bridge"] } },
            { "field.string":     { "name": "reference", "@required": true, "@maxLength": 80 } },
            { "field.timestamp":  { "name": "autoCreatedAt", "@autoSet": "onCreate" } },
            { "field.timestamp":  { "name": "autoUpdatedAt", "@autoSet": "onUpdate" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}},
          { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } }
          ]}}
        ]}}
        """;

    /** Same TPH shape but NO @autoSet — the byte-identical control. */
    private static final String NO_AUTOSET_TPH_JSON = """
        { "metadata.root": { "package": "acme::auth", "children": [
          { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb":       { "@table": "auths" } },
            { "field.long":       { "name": "id" } },
            { "field.enum":       { "name": "type", "@values": ["Bridge"] } },
            { "field.string":     { "name": "reference", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}},
          { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } }
          ]}}
        ]}}
        """;

    /**
     * FR-017 TPH base Device carrying NO {@code @autoSet} field, with a subtype SmartDevice
     * declaring its OWN {@code field.timestamp @autoSet} columns (one onCreate, one onUpdate) —
     * metadata the loader accepts. Regression fixture for the Task 3 review finding: the
     * per-subtype controller create/update gates must read the BASE's {@code @autoSet} fields
     * (matching {@code SpringDtoGenerator.emitTphUnion}'s helper-emission gate), never the
     * subtype's own resolving field set — otherwise the controller emits a phantom
     * {@code stampForInsert}/{@code stampAutoSetOnUpdate} call against a helper that was never
     * generated (the union {@code DeviceDto} only gets {@code stampForInsert} when the BASE
     * itself carries an {@code @autoSet} field).
     */
    private static final String SUBTYPE_OWN_AUTOSET_TPH_JSON = """
        { "metadata.root": { "package": "acme::device", "children": [
          { "object.entity": { "name": "Device", "@discriminator": "type", "children": [
            { "source.rdb":       { "@table": "devices" } },
            { "field.long":       { "name": "id" } },
            { "field.enum":       { "name": "type", "@values": ["Smart"] } },
            { "field.string":     { "name": "reference", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}},
          { "object.entity": { "name": "SmartDevice", "extends": "Device", "@discriminatorValue": "Smart", "children": [
            { "field.int":       { "name": "quantity", "@required": true } },
            { "field.timestamp": { "name": "activatedAt", "@autoSet": "onCreate" } },
            { "field.timestamp": { "name": "pingedAt", "@autoSet": "onUpdate" } }
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

    // === lane 1b: FR-017 TPH per-subtype controller stamping =================

    @Test
    public void tphPerSubtypeCreateStampsAutoSetBeforeDelegating() throws Exception {
        String src = generateTphController(TPH_AUTOSET_JSON, "Auth");
        String createBody = methodBody(src, "createBridge");
        // stamp above the consumer seam, then delegate — mirrors the vanilla createArg. The
        // stamp is nested AS the createWithType argument (identical shape to the vanilla
        // `repository.create(SubscriberDto.stampForInsert(dto))` — the call name always precedes
        // its own argument textually, so createWithType necessarily precedes stampForInsert here,
        // not the other way around).
        assertTrue("per-subtype create stamps @autoSet before createWithType; saw:\n" + createBody,
            createBody.contains(".stampForInsert(dto)"));
        assertTrue("stamp is passed AS the create argument (mirrors the vanilla createArg); saw:\n" + createBody,
            createBody.contains("createWithType(\"Bridge\", AuthDto.stampForInsert(dto))"));
    }

    @Test
    public void tphPerSubtypeUpdateStampsOnUpdate() throws Exception {
        String src = generateTphController(TPH_AUTOSET_JSON, "Auth");
        String updateBody = methodBody(src, "updateBridge");
        assertTrue("per-subtype update bumps onUpdate before patchByIdAndType; saw:\n" + updateBody,
            updateBody.contains("stampAutoSetOnUpdate"));
    }

    @Test
    public void tphControllerWithoutAutoSetIsByteIdentical() throws Exception {
        String src = generateTphController(NO_AUTOSET_TPH_JSON, "Auth");
        assertFalse("no stampForInsert in a non-@autoSet TPH controller; saw:\n" + src,
            src.contains("stampForInsert"));
        assertFalse("no stampAutoSetOnUpdate in a non-@autoSet TPH controller; saw:\n" + src,
            src.contains("stampAutoSetOnUpdate"));
    }

    /**
     * Review fix regression (Task 3, commit b5fc7741): a TPH subtype declaring its OWN
     * {@code @autoSet} column — with the BASE carrying none — must never be stamped by the
     * generated controller, and must never produce a phantom call against a helper that was
     * never generated. Before the fix, the per-subtype create/update gates read
     * {@code st.entity()} (subtype-resolving, which includes SmartDevice's own
     * {@code activatedAt}/{@code pingedAt}) so they fired {@code true} and the controller emitted
     * {@code DeviceDto.stampForInsert(dto)} / {@code patch.stampAutoSetOnUpdate()} — but
     * {@code SpringDtoGenerator.emitTphUnion} gates the union {@code DeviceDto}'s
     * {@code stampForInsert} helper on {@code AutoSetSupport.hasAutoSetFields(base)}, which is
     * FALSE here (the base has no {@code @autoSet} field), so {@code DeviceDto} never gets that
     * static method: a non-compiling controller. Fails before the fix (the controller string
     * assertions below saw the phantom calls); passes after.
     */
    @Test
    public void tphSubtypeOwnAutoSetIsNeverStampedAndDtoLayerCompiles() throws Exception {
        Path srcDir = tmp.newFolder("subtype-own-src").toPath();
        Path classesDir = tmp.newFolder("subtype-own-classes").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder("subtype-own-fx").toPath(), "device", SUBTYPE_OWN_AUTOSET_TPH_JSON);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringControllerGenerator(), loader, srcDir);

        String ctrl = Files.readString(srcDir.resolve("acme/device/DeviceController.java"));
        assertFalse("subtype-own @autoSet must NOT be stamped on create (base has none); saw:\n" + ctrl,
            ctrl.contains("stampForInsert("));
        assertFalse("subtype-own @autoSet must NOT be stamped on update (base has none); saw:\n" + ctrl,
            ctrl.contains("stampAutoSetOnUpdate"));
        assertTrue("verbatim per-subtype create (no stamping); saw:\n" + ctrl,
            ctrl.contains("createWithType(\"Smart\", dto)"));

        // Compile the DTO/Patch layer only — like tphUnionDtoAndSubPatchCarryTheStampingHelpers,
        // NOT the controller itself, whose Spring Web MVC / jakarta.servlet imports aren't on this
        // module's test classpath (see GeneratedM2mTraversalCompileRunTest's rationale). Delete the
        // controller source from srcDir first so compile()'s directory walk doesn't pick it up.
        Files.delete(srcDir.resolve("acme/device/DeviceController.java"));
        compile(srcDir, classesDir);

        // Lock the "phantom call would not compile" claim directly: the union DeviceDto
        // genuinely declares NO stampForInsert method (gated on the BASE, which has no @autoSet
        // field) — so the pre-fix controller's DeviceDto.stampForInsert(dto) call would have been
        // a compile error had the controller been compiled alongside it.
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Class<?> deviceDto = cl.loadClass("acme.device.DeviceDto");
            boolean hasStampForInsert = Stream.of(deviceDto.getMethods())
                .anyMatch(m -> m.getName().equals("stampForInsert"));
            assertFalse("DeviceDto (TPH union; base has no @autoSet) must NOT declare stampForInsert",
                hasStampForInsert);
        }
    }

    @Test
    public void tphUnionDtoAndSubPatchCarryTheStampingHelpers() throws Exception {
        Path srcDir = tmp.newFolder("tph-src").toPath();
        Path classesDir = tmp.newFolder("tph-classes").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("tph-fx").toPath(), "auth", TPH_AUTOSET_JSON);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        // Real javac compile of the DTO layer (AuthDto + BridgeAuthDto/Copay.../Patch) — not just
        // string assertions. Catches exactly the class of bug found while implementing this: a
        // subtype-typed stampForInsert(BridgeAuthDto) would NOT type-check if the controller ever
        // called it with an AuthDto argument (the union type repository.createWithType binds).
        // The controller itself is intentionally NOT compiled here (Spring MVC is not a
        // codegen-spring test dependency — see GeneratedM2mTraversalCompileRunTest's rationale;
        // the controller's shape is string-gated by the tests above + SpringControllerGeneratorTest).
        compile(srcDir, classesDir);

        // The BASE union <Base>Dto — NOT a standalone <Sub>Dto — carries stampForInsert: the TPH
        // controller's create handler binds/returns the union type (repository.createWithType),
        // so the stamp helper the controller calls must be typed to that same union record.
        String authDto = Files.readString(srcDir.resolve("acme/auth/AuthDto.java"));
        assertTrue("AuthDto (TPH union) must carry stampForInsert; saw:\n" + authDto,
            authDto.contains("public static AuthDto stampForInsert(AuthDto dto)"));

        // The per-subtype <Sub>Patch carries the onUpdate stamping hook (mirrors the vanilla
        // <Entity>Patch), consumed by the controller's updateBridge handler.
        String bridgePatch = Files.readString(srcDir.resolve("acme/auth/BridgeAuthPatch.java"));
        assertTrue("BridgeAuthPatch must carry stampAutoSetOnUpdate(); saw:\n" + bridgePatch,
            bridgePatch.contains("public void stampAutoSetOnUpdate()"));
        assertTrue("BridgeAuthPatch stamps autoUpdatedAt; saw:\n" + bridgePatch,
            bridgePatch.contains("assigned.put(\"autoUpdatedAt\", java.time.Instant.now());"));

        // The standalone <Sub>Dto (BridgeAuthDto) — used elsewhere only for its .class in
        // per-field validateValue calls — ALSO gets the helpers for parity with the vanilla DTO
        // contract (a consumer using it standalone, outside the TPH union path, gets the same
        // stamping affordance).
        String bridgeDto = Files.readString(srcDir.resolve("acme/auth/BridgeAuthDto.java"));
        assertTrue("BridgeAuthDto must ALSO carry stampForInsert (vanilla-DTO parity); saw:\n" + bridgeDto,
            bridgeDto.contains("public static BridgeAuthDto stampForInsert(BridgeAuthDto dto)"));

        // Neither the create-validated set nor the <Sub>Patch settable set can bind @autoSet from
        // the caller: no has<AutoSetField>() accessor on the patch.
        assertFalse("BridgeAuthPatch must not expose a settable autoCreatedAt accessor; saw:\n" + bridgePatch,
            bridgePatch.contains("hasAutoCreatedAt"));
        assertFalse("BridgeAuthPatch must not expose a settable autoUpdatedAt accessor; saw:\n" + bridgePatch,
            bridgePatch.contains("hasAutoUpdatedAt"));
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

    /** Generate the DTO + controller for a TPH fixture and return the base's {@code <Base>Controller.java}
     *  source (path {@code acme/auth/<baseShortName>Controller.java} — every TPH fixture in this file
     *  uses package {@code acme::auth}). The DTO generator must run first: the controller's per-subtype
     *  create/update reference the generated {@code <Sub>Patch} / stamping helpers. */
    private String generateTphController(String json, String baseShortName) throws Exception {
        Path srcDir = tmp.newFolder().toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "tph", json);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        return Files.readString(srcDir.resolve("acme/auth/" + baseShortName + "Controller.java"));
    }

    /** Extract one generated method's body: from just after its signature line up to whichever
     *  comes first — the next member's {@code @}-annotation, the next subtype's {@code // ---}
     *  comment, or the next {@code private} helper. Sufficient for this file's contains/matches
     *  string-gate style (no brace-balancing attempted). */
    private static String methodBody(String src, String methodName) {
        int sigIdx = src.indexOf(methodName + "(");
        assertTrue("method " + methodName + " not found; saw:\n" + src, sigIdx >= 0);
        int bodyStart = src.indexOf('\n', sigIdx) + 1;
        assertTrue("method " + methodName + " signature has no body; saw:\n" + src, bodyStart > 0);
        int end = src.length();
        for (String marker : new String[] { "\n    @", "\n    // ---", "\n    private " }) {
            int idx = src.indexOf(marker, bodyStart);
            if (idx >= 0 && idx < end) end = idx;
        }
        return src.substring(bodyStart, end);
    }

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
