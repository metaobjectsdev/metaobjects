package com.metaobjects.generator.template;

import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataLoaderTestBase;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;

/**
 * Oracle: the shared template-codegen corpus, whose {@code expected/} tree names the file each
 * scope writes for the full model. A per-entity scope narrowed to one object writes that
 * object's file only; per-package and per-model files stay whole.
 */
public class TemplateScopeGeneratorSelectionTest extends MetaDataLoaderTestBase {

    private static Path corpus() {
        return Path.of(System.getProperty("user.dir")).resolve("../../..")
            .resolve("fixtures/template-codegen-conformance").normalize();
    }

    private List<String> run(String scope, String pattern, List<String> entities) throws Exception {
        Path corpus = corpus();
        MetaDataLoader loader = initLoader(List.of(corpus.resolve("metadata/meta.shop.json").toUri()));
        Path out = Files.createTempDirectory("tmpl-select-java");
        String template = switch (scope) {
            case ScopeWalk.PER_ENTITY -> "entity";
            case ScopeWalk.PER_PACKAGE -> "package";
            default -> "model";
        };
        TemplateScopeGenerator gen = new TemplateScopeGenerator();
        gen.setArgs(Map.of(
            TemplateScopeGenerator.ARG_TEMPLATE, template,
            TemplateScopeGenerator.ARG_SCOPE, scope,
            TemplateScopeGenerator.ARG_OUTPUT_PATTERN, pattern,
            TemplateScopeGenerator.ARG_TEMPLATES_DIR, corpus.resolve("templates").toString(),
            GeneratorBase.ARG_OUTPUTDIR, out.toString()));
        gen.setEntities(entities);
        gen.execute(loader);
        try (Stream<Path> s = Files.walk(out)) {
            return s.filter(Files::isRegularFile)
                .map(p -> out.relativize(p).toString())
                .sorted()
                .collect(Collectors.toList());
        }
    }

    @Test public void perEntityScopeWritesOnlyTheSelectedObject() throws Exception {
        assertEquals(List.of("Product.txt"), run(ScopeWalk.PER_ENTITY, "{name}.txt", List.of("Product")));
    }

    @Test public void perEntityScopeWithNoSelectionWritesEveryObject() throws Exception {
        assertEquals(List.of("Order.txt", "Product.txt"), run(ScopeWalk.PER_ENTITY, "{name}.txt", List.of()));
    }

    @Test public void wholeModelScopesStayWholeUnderASelection() throws Exception {
        assertEquals(List.of("_model.txt"), run(ScopeWalk.PER_MODEL, "_model.txt", List.of("Product")));
        assertEquals(List.of("shop/_package.txt"),
            run(ScopeWalk.PER_PACKAGE, "{package}/_package.txt", List.of("Product")));
    }
}
