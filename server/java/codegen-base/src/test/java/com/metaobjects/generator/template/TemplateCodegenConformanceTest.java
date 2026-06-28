package com.metaobjects.generator.template;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataLoaderTestBase;
import com.metaobjects.object.MetaObject;
import com.metaobjects.render.FilesystemProvider;
import com.metaobjects.render.Provider;
import com.metaobjects.render.templategen.EmittedFile;
import com.metaobjects.render.templategen.TemplateGenerator;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * Cross-port conformance gate (Java): runs {@code spec.json} over the shared
 * {@code fixtures/template-codegen-conformance/} corpus and asserts the output
 * is byte-identical to {@code expected/} (the TS-produced oracle). Because the
 * render engine is already byte-equal across ports, any diff here is a JVM
 * data-dict or scope/pattern bug — never a reason to edit {@code expected/}.
 */
public class TemplateCodegenConformanceTest extends MetaDataLoaderTestBase {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static Path corpus() {
        return Path.of(System.getProperty("user.dir")).resolve("../../..")
            .resolve("fixtures/template-codegen-conformance").normalize();
    }

    private static List<String> relFiles(Path root) throws IOException {
        try (Stream<Path> s = Files.walk(root)) {
            return s.filter(Files::isRegularFile)
                .map(p -> root.relativize(p).toString())
                .sorted()
                .collect(Collectors.toList());
        }
    }

    @Test public void corpusMatchesExpectedByteForByte() throws Exception {
        Path corpus = corpus();
        JsonNode spec = JSON.readTree(corpus.resolve("spec.json").toFile());
        MetaDataLoader loader = initLoader(List.of(corpus.resolve("metadata/meta.shop.json").toUri()));
        List<MetaObject> objects = loader.getMetaObjects();
        Provider provider = new FilesystemProvider(corpus.resolve("templates"));

        Path out = Files.createTempDirectory("tmpl-conf-java");
        List<EmittedFile> emitted = new ArrayList<>();
        for (JsonNode g : spec.get("generators")) {
            String scope = g.get("scope").asText();
            String pattern = g.get("outputPattern").asText();
            String fmt = g.has("format") ? g.get("format").asText() : "text";
            emitted.addAll(TemplateGenerator.generate(
                g.get("name").asText(),
                g.get("template").asText(),
                root -> ScopeWalk.forScope(scope, pattern).apply(objects),
                provider, fmt, objects));
        }
        for (EmittedFile f : emitted) {
            Path p = out.resolve(f.path());
            Files.createDirectories(p.getParent() == null ? out : p.getParent());
            Files.writeString(p, f.content());
        }

        Path expected = corpus.resolve("expected");
        assertEquals("emitted file set must match expected/", relFiles(expected), relFiles(out));
        for (String rel : relFiles(expected)) {
            assertEquals("byte mismatch in " + rel,
                Files.readString(expected.resolve(rel)),
                Files.readString(out.resolve(rel)));
        }
    }
}
