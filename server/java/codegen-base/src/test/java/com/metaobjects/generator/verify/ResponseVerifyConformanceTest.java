package com.metaobjects.generator.verify;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaData;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.template.MetaTemplate;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameter;
import org.junit.runners.Parameterized.Parameters;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Runs the shared reply-check corpus ({@code fixtures/response-verify-conformance/cases.json})
 * against this port: what {@code metaobjects:verify mode=templates} reports about each prompt's
 * {@code @responseRef}. {@code expect} is the exhaustive finding list for the case's templates.
 */
@RunWith(Parameterized.class)
public class ResponseVerifyConformanceTest extends SharedRegistryTestBase {

    private record Case(String name, String metadata, List<String> expect) {}

    @Parameters(name = "{0}")
    public static Collection<Object[]> cases() throws IOException {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        assertNotNull("could not locate the repository fixtures/ directory", dir);
        Path corpus = dir.resolve("fixtures/response-verify-conformance/cases.json");
        JsonArray arr = JsonParser.parseString(Files.readString(corpus, StandardCharsets.UTF_8))
                .getAsJsonObject().getAsJsonArray("cases");
        List<Object[]> rows = new ArrayList<>();
        for (JsonElement el : arr) {
            JsonObject c = el.getAsJsonObject();
            List<String> expect = new ArrayList<>();
            for (JsonElement f : c.getAsJsonArray("expect")) {
                JsonObject o = f.getAsJsonObject();
                expect.add(o.get("template").getAsString() + "|" + o.get("code").getAsString() + "|"
                        + o.get("path").getAsString() + "|" + o.get("severity").getAsString());
            }
            expect.sort(String::compareTo);
            String name = c.get("name").getAsString();
            rows.add(new Object[]{name, new Case(name, c.get("metadata").toString(), expect)});
        }
        return rows;
    }

    @Parameter(0)
    public String caseName;

    @Parameter(1)
    public Case testCase;

    @Test
    public void reportsTheSameReplyFindings() throws Exception {
        Path tmp = Files.createTempDirectory("mo-reply-verify-");
        try {
            Path file = tmp.resolve("meta.json");
            Files.writeString(file, testCase.metadata(), StandardCharsets.UTF_8);
            List<URI> uris = List.of(URIHelper.toURI("model:file:" + file.toAbsolutePath().toString().replace('\\', '/')));
            MetaDataLoader loader = new MetaDataLoader(
                    LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "reply-" + testCase.name());
            loader.setSourceURIs(uris);
            loader.init();

            List<String> got = new ArrayList<>();
            for (MetaData child : loader.getRoot().getChildren()) {
                if (!(child instanceof MetaTemplate tmpl)) continue;
                for (TemplateVerify.ResponseFinding f : TemplateVerify.responseFindings(loader, tmpl)) {
                    got.add(tmpl.getShortName() + "|" + f.code() + "|" + f.path() + "|"
                            + (f.warning() ? "warning" : "error"));
                }
            }
            got.sort(String::compareTo);
            assertEquals(testCase.expect(), got);
        } finally {
            try (var walk = Files.walk(tmp)) {
                walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            }
        }
    }

    @Test
    public void corpusIsNotEmpty() throws Exception {
        assertTrue(cases().size() > 0);
    }
}
