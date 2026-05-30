package com.metaobjects.generator.spring;

import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Cross-port conformance: codegen-spring must NEVER emit instance/write
 * artifacts (controllers, repositories, filter allowlists, DTO records) for
 * an entity declared {@code abstract: true}. A configurable knob
 * {@code emitAbstractShapes} (default OFF for Java) controls whether an
 * abstract <em>shape</em> artifact is emitted instead — for the DTO generator
 * that shape is a Java {@code interface}, since a record cannot be a base type.
 *
 * <p>Exercises the shared repo fixture
 * {@code fixtures/codegen-conformance/abstract/input/meta.abstract.json}
 * (package {@code acme::shop}): two abstract entities ({@code AbstractRecord},
 * {@code BaseShape}) and one concrete entity ({@code Widget extends BaseShape}).</p>
 */
public class AbstractConformanceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    // -------------------------------------------------------------------------
    // Harness
    // -------------------------------------------------------------------------

    /** Resolve + load the shared cross-port abstract fixture into a fresh loader. */
    private MetaDataLoader loadShared() throws IOException {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path fixture = repoRoot.resolve("fixtures/codegen-conformance/abstract/input/meta.abstract.json");
        assertTrue("shared fixture must exist at " + fixture, Files.exists(fixture));
        String json = Files.readString(fixture);
        Path workspace = tmp.newFolder().toPath();
        return SpringTestFixtures.loadFixture(workspace, "metaAbstract", json);
    }

    /** Run any MultiFileDirectGeneratorBase<MetaObject> against a fresh output dir; returns the out root. */
    private Path run(MultiFileDirectGeneratorBase<MetaObject> gen, MetaDataLoader loader,
                     Map<String, String> extraArgs) throws IOException {
        Path out = tmp.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        if (extraArgs != null) args.putAll(extraArgs);
        gen.setArgs(args);
        gen.execute(loader);
        return out;
    }

    private Path run(MultiFileDirectGeneratorBase<MetaObject> gen, MetaDataLoader loader) throws IOException {
        return run(gen, loader, null);
    }

    private static void assertAbstractSuppressed(Path out, String suffix) {
        Path pkgDir = out.resolve("acme/shop");
        assertFalse("AbstractRecord" + suffix + ".java must NOT be emitted (abstract entity)",
            Files.exists(pkgDir.resolve("AbstractRecord" + suffix + ".java")));
        assertFalse("BaseShape" + suffix + ".java must NOT be emitted (abstract entity)",
            Files.exists(pkgDir.resolve("BaseShape" + suffix + ".java")));
        assertTrue("Widget" + suffix + ".java MUST be emitted (concrete entity)",
            Files.exists(pkgDir.resolve("Widget" + suffix + ".java")));
    }

    // -------------------------------------------------------------------------
    // Task 2.2 — abstract entities produce no instance/write artifacts
    // -------------------------------------------------------------------------

    @Test
    public void controllerSkipsAbstractEntities() throws Exception {
        Path out = run(new SpringControllerGenerator(), loadShared());
        assertAbstractSuppressed(out, "Controller");
    }

    @Test
    public void repositorySkipsAbstractEntities() throws Exception {
        Path out = run(new SpringRepositoryGenerator(), loadShared());
        assertAbstractSuppressed(out, "Repository");
    }

    @Test
    public void filterAllowlistSkipsAbstractEntities() throws Exception {
        Path out = run(new SpringFilterAllowlistGenerator(), loadShared());
        assertAbstractSuppressed(out, "FilterAllowlist");
    }

    @Test
    public void dtoSkipsAbstractEntitiesByDefault() throws Exception {
        Path out = run(new SpringDtoGenerator(), loadShared());
        assertAbstractSuppressed(out, "Dto");
    }

    // -------------------------------------------------------------------------
    // Task 2.3 — emitAbstractShapes knob (DTO generator)
    // -------------------------------------------------------------------------

    @Test
    public void dtoKnobOffEmitsNoAbstractShapes() throws Exception {
        Map<String, String> args = new HashMap<>();
        args.put("emitAbstractShapes", "false");
        Path out = run(new SpringDtoGenerator(), loadShared(), args);
        assertAbstractSuppressed(out, "Dto");
    }

    @Test
    public void dtoKnobOnEmitsAbstractInterfaceShape() throws Exception {
        Map<String, String> args = new HashMap<>();
        args.put("emitAbstractShapes", "true");
        Path out = run(new SpringDtoGenerator(), loadShared(), args);
        Path pkgDir = out.resolve("acme/shop");

        Path absDto = pkgDir.resolve("AbstractRecordDto.java");
        assertTrue("AbstractRecordDto.java MUST be emitted when emitAbstractShapes=true",
            Files.exists(absDto));
        String src = Files.readString(absDto);
        assertTrue("abstract DTO shape must be a Java interface; saw:\n" + src,
            src.contains("public interface AbstractRecordDto"));

        // BaseShape (abstract) shape is also emitted under the knob.
        assertTrue("BaseShapeDto.java MUST be emitted when emitAbstractShapes=true",
            Files.exists(pkgDir.resolve("BaseShapeDto.java")));
        // Concrete entity still emits its record.
        assertTrue("WidgetDto.java MUST be emitted (concrete entity)",
            Files.exists(pkgDir.resolve("WidgetDto.java")));
    }
}
