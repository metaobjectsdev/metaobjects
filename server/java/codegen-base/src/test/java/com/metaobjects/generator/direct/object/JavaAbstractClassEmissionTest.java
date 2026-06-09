package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Locks the abstract-class emission of the flavored-object Java generator: an
 * {@code abstract: true} object must emit {@code public abstract class <Name>} so it
 * cannot be instantiated and serves only as the base its concrete subtypes inherit,
 * while a concrete subtype that {@code extends} it emits a plain (instantiable)
 * {@code public class}. The abstract read is own-only ({@code GeneratorUtil.isAbstract}),
 * so the concrete subtype is NOT marked abstract.
 *
 * <p>Applies to all three {@code JavaCodeWriter} subclasses (the legacy writer plus the
 * {@code valueObject} / {@code pojoAware} flavors, which delegate to its
 * {@code writeObjectHeader}); exercised here through the {@code valueObject} flavor.</p>
 */
public class JavaAbstractClassEmissionTest {

    private static final String PKG = "acme::shapes";

    // An abstract base value-object + a concrete subtype that extends it.
    private static final String META = "{ \"metadata.root\": {"
        + "  \"package\": \"" + PKG + "\","
        + "  \"children\": ["
        + "    { \"object.value\": { \"name\": \"Shape\", \"abstract\": true, \"children\": ["
        + "      { \"field.string\": { \"name\": \"label\" } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"Circle\", \"extends\": \"Shape\", \"children\": ["
        + "      { \"field.double\": { \"name\": \"radius\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    private MetaDataLoader loadMeta() {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "abstract-emission-cr");
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "abstract-emission-cr/meta.json")));
        return loader;
    }

    private Path generate(String flavor) throws Exception {
        Path gen = tmp.newFolder("gen-" + flavor).toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("type", "class");
        args.put("flavor", flavor);
        JavaObjectCodeGenerator generator = new JavaObjectCodeGenerator();
        generator.setArgs(args);
        generator.execute(loadMeta());
        return gen;
    }

    @Test
    public void abstractObjectEmitsAbstractClassConcreteStaysPlain() throws Exception {
        Path gen = generate("valueObject");
        Path pkgDir = gen.resolve("acme/shapes");

        Path shape = pkgDir.resolve("Shape.java");
        Path circle = pkgDir.resolve("Circle.java");
        assertTrue("abstract base Shape.java must be emitted (concretes inherit it)", Files.exists(shape));
        assertTrue("concrete Circle.java must be emitted", Files.exists(circle));

        String shapeSrc = Files.readString(shape);
        String circleSrc = Files.readString(circle);

        // The abstract object emits `public abstract class Shape` — non-instantiable base.
        assertTrue("abstract object must emit `public abstract class Shape`; saw:\n" + shapeSrc,
            shapeSrc.contains("public abstract class Shape"));

        // The concrete subtype is a plain (instantiable) class — own-only abstract read,
        // so extending an abstract base does NOT make the concrete abstract.
        assertTrue("concrete object must emit `public class Circle`; saw:\n" + circleSrc,
            circleSrc.contains("public class Circle"));
        assertFalse("concrete subtype must NOT be marked abstract; saw:\n" + circleSrc,
            circleSrc.contains("public abstract class Circle"));
    }
}
