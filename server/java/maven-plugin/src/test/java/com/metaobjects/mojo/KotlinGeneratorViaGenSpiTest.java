package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Test;

import java.lang.reflect.Constructor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.stream.Stream;

import static org.junit.Assert.assertTrue;

/**
 * Confirmation test: a {@code codegen-kotlin} generator loads + runs through the SAME
 * reflective SPI path that {@code meta:gen} (and {@code meta:verify}) use — i.e. no new
 * Kotlin-specific Mojo is required.
 *
 * <p>The Mojo's {@link AbstractMetaDataMojo#buildGenerators} does exactly this: load the
 * class by its FQN off the project classloader, invoke its no-arg constructor, call
 * {@link Generator#setArgs}/{@code setFilters}/{@code setScripts}, then
 * {@link Generator#execute(MetaDataLoader)}. {@code KotlinEntityGenerator} extends
 * {@code MultiFileDirectGeneratorBase} (a {@link Generator}) with a no-arg constructor and
 * reads its {@code outputDir} from args — so the same mechanism drives it unchanged. This
 * test reproduces that exact path by classname (no compile-time reference to the Kotlin
 * type), and asserts a {@code .kt} file is emitted.</p>
 */
public class KotlinGeneratorViaGenSpiTest {

    /** The codegen-kotlin entity generator, referenced by FQN exactly as a POM would. */
    private static final String KOTLIN_GEN_FQN =
            "com.metaobjects.generator.kotlin.KotlinEntityGenerator";

    @Test
    public void kotlinGeneratorRunsThroughTheGenSpi() throws Exception {
        Path outDir = Files.createTempDirectory("kotlin-gen-spi");

        // 1. Build a loader the same way AbstractMetaDataMojo.createLoader does.
        MetaDataLoader loader = buildLoader();

        // 2. Reflectively instantiate the Kotlin generator by FQN — the meta:gen SPI.
        Class<?> generatorClass = Thread.currentThread().getContextClassLoader()
                .loadClass(KOTLIN_GEN_FQN);
        // Prove it is a Generator (the SPI contract the Mojo casts to).
        assertTrue(KOTLIN_GEN_FQN + " must implement the Generator SPI the Mojo loads",
                Generator.class.isAssignableFrom(generatorClass));

        Constructor<?> ctor = generatorClass.getDeclaredConstructor();
        Generator gen = (Generator) ctor.newInstance();

        // 3. Configure + run exactly as buildGenerators + executeGenerators do.
        gen.setArgs(Collections.singletonMap("outputDir", outDir.toString()));
        gen.setFilters(Collections.emptyList());
        // NB: scripts are intentionally NOT set — Direct generators reject scripts, and the
        // gen Mojo only calls setScripts when the <generator> declares some.
        gen.execute(loader);

        // 4. The Kotlin generator emitted at least one .kt file through the shared SPI.
        try (Stream<Path> s = Files.walk(outDir)) {
            long kt = s.filter(p -> p.toString().endsWith(".kt")).count();
            assertTrue("Kotlin generator should emit .kt files via the meta:gen SPI", kt > 0);
        }
    }

    private MetaDataLoader buildLoader() {
        ClassLoader cl = Thread.currentThread().getContextClassLoader();
        MetaDataLoader loader = new MetaDataLoader(
                com.metaobjects.loader.LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "kotlin-spi-test");
        loader.getTypeRegistry().getRegisteredTypes();
        MavenLoaderConfiguration.configure(
                loader, "./src/test/resources", cl,
                Collections.singletonList("mojo/verify-test-metadata.json"),
                Collections.emptyMap());
        return loader.getLoader();
    }
}
