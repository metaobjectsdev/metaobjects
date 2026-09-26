package com.metaobjects.generator;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataLoaderTestBase;
import org.junit.Test;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;
import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * The Java example generators in {@code docs/recipes/generators/java/} are what the guidance
 * tells a JVM adopter to copy (ADR-0034 Amendment 4). This compiles them VERBATIM against the
 * current codegen-base, runs each through its {@code Generator} SPI exactly as
 * {@code metaobjects:generate} does, and checks the output — so the recipe cannot rot against
 * {@link FileEmittingGenerator} / {@link ModelWalk}. It pins that they WORK, not what they emit
 * to anyone: they are examples, not a product surface. (The Kotlin recipe is gated the same
 * way by codegen-kotlin's {@code RecipeGeneratorCompileRunTest}.)
 */
public class RecipeGeneratorsCompileRunTest extends MetaDataLoaderTestBase {

    private static Path recipes() {
        return Path.of(System.getProperty("user.dir")).resolve("../../../docs/recipes/generators/java").normalize();
    }

    @Test public void javaRecipesCompileAndGenerate() throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.list(recipes())) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
        }
        assertEquals(2, sources.size());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK required", javac);
        Path classes = Files.createTempDirectory("mo-recipes-classes");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        boolean ok = javac.getTask(null, fm, diags,
            List.of("-classpath", System.getProperty("java.class.path"), "-d", classes.toString()),
            null, fm.getJavaFileObjectsFromFiles(sources)).call();
        assertTrue("recipes failed to compile: " + diags.getDiagnostics(), ok);

        MetaDataLoader loader = initLoader(List.of(getClass().getResource("/generator-authoring/meta.shop.json").toURI()));
        Path out = Files.createTempDirectory("mo-recipes-out");
        try (URLClassLoader cl = new URLClassLoader(new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {
            Generator schema = (Generator) cl.loadClass("com.acme.codegen.JsonSchemaGenerator").getConstructor().newInstance();
            schema.setArgs(Map.of(GeneratorBase.ARG_OUTPUTDIR, out.resolve("schemas").toString())).execute(loader);

            Generator api = (Generator) cl.loadClass("com.acme.codegen.OpenApiGenerator").getConstructor().newInstance();
            api.setArgs(Map.of(GeneratorBase.ARG_OUTPUTDIR, out.resolve("api").toString(),
                "title", "Shop", "apiPrefix", "/api")).execute(loader);
        }

        String cat = Files.readString(out.resolve("schemas/PostCategory.schema.json"));
        assertTrue(cat, cat.contains("\"createdAt\": {\n      \"type\": \"string\",\n      \"format\": \"date-time\"\n    }"));
        assertTrue("inherited array", cat.contains("\"labels\": {\n      \"type\": \"array\""));
        assertTrue("package-aware ref", cat.contains("\"$ref\": \"./Address.schema.json\""));
        assertTrue("inherited @required", cat.contains("\"createdAt\"\n  ]"));
        assertFalse("no schema for the abstract base", Files.exists(out.resolve("schemas/BaseEntity.schema.json")));

        String openapi = Files.readString(out.resolve("api/openapi.json"));
        assertTrue(openapi.contains("\"openapi\": \"3.1.0\""));
        assertTrue("cross-port collection segment", openapi.contains("\"/api/post_categories/{id}\""));
        assertFalse("a value object gets no path", openapi.contains("/api/addresses"));

        // Deterministic: a second run over the same model is byte-identical (verify depends on it).
        Path again = Files.createTempDirectory("mo-recipes-again");
        try (URLClassLoader cl = new URLClassLoader(new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {
            Generator api = (Generator) cl.loadClass("com.acme.codegen.OpenApiGenerator").getConstructor().newInstance();
            api.setArgs(Map.of(GeneratorBase.ARG_OUTPUTDIR, again.toString(), "title", "Shop", "apiPrefix", "/api")).execute(loader);
        }
        assertEquals(openapi, Files.readString(again.resolve("openapi.json")));
    }
}
