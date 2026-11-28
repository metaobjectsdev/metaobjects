package com.metaobjects.docsview;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.loader.DirectorySource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * The docs view corpus ({@code fixtures/explorer-conformance/}, {@code docs/features/docs-view.md}):
 * each fixture's project is loaded strictly, its committed optional inputs are read, and
 * {@link DocsView} must reproduce the fixture's {@code expected.json} byte for byte, as the
 * TypeScript reference does. A fixture's {@code provider.json} is applied before loading, every
 * type it declares a plain node.
 */
public class DocsViewConformanceTest {

    /** A node of a type a fixture's provider.json declares: no behaviour beyond MetaData's own. */
    public static final class FixtureNode extends MetaData {
        public FixtureNode(String type, String subType, String name) {
            super(type, subType, name);
        }
    }

    public static Path corpus() {
        for (Path p = Path.of("").toAbsolutePath(); p != null; p = p.getParent()) {
            Path c = p.resolve("fixtures/explorer-conformance");
            if (Files.isDirectory(c)) return c;
        }
        throw new IllegalStateException("fixtures/explorer-conformance not found above " + Path.of("").toAbsolutePath());
    }

    public static List<String> fixtures() throws IOException {
        List<String> out = new ArrayList<>();
        try (Stream<Path> s = Files.list(corpus())) {
            s.filter(Files::isDirectory).map(p -> p.getFileName().toString()).sorted().forEach(out::add);
        }
        return out;
    }

    public static JsonElement readJson(Path dir, String name) throws IOException {
        Path p = dir.resolve(name);
        return Files.isRegularFile(p) ? JsonParser.parseString(Files.readString(p, StandardCharsets.UTF_8)) : null;
    }

    /** A provider for a fixture's provider.json: every type a plain node, its attrs and child slots as declared. */
    static MetaDataTypeProvider fixtureProvider(JsonObject def) {
        return new MetaDataTypeProvider() {
            @Override public String getProviderId() { return def.get("provider").getAsString(); }
            @Override public String[] getDependencies() { return new String[]{"core-types", "attribute-types", "object-types"}; }
            @Override public String getDescription() { return "Test-only: a docs-view fixture's vocabulary."; }
            @Override public void registerTypes(MetaDataRegistry registry) {
                for (JsonElement t : def.getAsJsonArray("types")) {
                    JsonObject type = t.getAsJsonObject();
                    registry.registerType(FixtureNode.class, b -> {
                        b.type(type.get("type").getAsString()).subType(type.get("subType").getAsString())
                         .description(type.get("description").getAsString());
                        slots(b, type.getAsJsonArray("children"));
                    });
                }
                for (JsonElement e : def.getAsJsonArray("extends")) {
                    JsonObject ext = e.getAsJsonObject();
                    assertEquals("metadata", ext.get("type").getAsString());
                    registry.extendType(MetaRoot.class, b -> slots(b, ext.getAsJsonArray("children")));
                }
            }
        };
    }

    private static void slots(com.metaobjects.registry.TypeDefinitionBuilder b, JsonArray children) {
        for (JsonElement c : children) {
            JsonObject slot = c.getAsJsonObject();
            String type = slot.get("type").getAsString();
            String name = slot.get("name").getAsString();
            if (MetaAttribute.TYPE_ATTR.equals(type)) {
                var a = slot.get("min").getAsInt() > 0
                    ? b.requiredAttributeWithConstraints(name) : b.optionalAttributeWithConstraints(name);
                var typed = a.ofType(StringAttribute.SUBTYPE_STRING);
                if (slot.has("isArray") && slot.get("isArray").getAsBoolean()) typed.asArray();
                else typed.asSingle();
            } else {
                b.optionalChild(type, slot.get("subType").getAsString(), name);
            }
        }
    }

    /** A fixture's project, loaded strictly with its provider.json applied; other ports' suites reuse it. */
    public static MetaDataLoader load(String name) throws IOException {
        Path dir = corpus().resolve(name);
        JsonElement def = readJson(dir, "provider.json");
        LoaderOptions opts = LoaderOptions.create(false, false, true);
        if (def != null) opts.setProviders(List.of(fixtureProvider(def.getAsJsonObject())));
        MetaDataLoader loader = new MetaDataLoader(opts, MetaDataLoader.SUBTYPE_MANUAL, "docs_view_" + name.replace('-', '_'));
        loader.init();
        loader.load(new DirectorySource(dir.resolve("project/metaobjects"), new DirectorySource.Options()).expandToList());
        assertTrue(name + ": expected a clean strict load, got: " + loader.getErrors(), loader.getErrors().isEmpty());
        return loader;
    }

    static JsonObject viewOf(String name) throws IOException {
        Path dir = corpus().resolve(name);
        return DocsView.build(load(name).getRoot(), readJson(dir, "verify.json"), readJson(dir, "hashes.json"), readJson(dir, "routes.json"));
    }

    @Test
    public void corpusHoldsTheFixturesTheReadmeDescribes() throws IOException {
        assertEquals(List.of("crm", "model-alone", "shop"), fixtures());
    }

    @Test
    public void everyFixtureReproducesExpectedJson() throws IOException {
        List<String> failures = new ArrayList<>();
        for (String name : fixtures()) {
            String expected = Files.readString(corpus().resolve(name).resolve("expected.json"), StandardCharsets.UTF_8);
            String actual = DocsView.serialize(viewOf(name));
            if (!expected.equals(actual)) {
                String scratch = System.getenv("DOCS_VIEW_ACTUAL_DIR");
                if (scratch != null) Files.writeString(Path.of(scratch, name + ".json"), actual, StandardCharsets.UTF_8);
                failures.add(name);
            }
        }
        assertEquals("docs view differs from expected.json (set DOCS_VIEW_ACTUAL_DIR to write what this port builds)",
            List.of(), failures);
    }

    @Test
    public void jsonWriterMatchesJavaScript() {
        assertEquals("1.5", DocsViewJson.number(1.5));
        assertEquals("3", DocsViewJson.number(3.0));
        assertEquals("1e+21", DocsViewJson.number(1e21));
        assertEquals("100000000000000000000", DocsViewJson.number(1e20));
        assertEquals("0.000001", DocsViewJson.number(0.000001));
        assertEquals("1e-7", DocsViewJson.number(1e-7));
        assertEquals("-12.25", DocsViewJson.number(-12.25));
        assertEquals("\"a\\u0001<>& \\ud800\"", DocsViewJson.quote("a\u0001<>& \ud800"));
    }
}
