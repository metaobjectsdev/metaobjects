package com.metaobjects.render;

import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;

/**
 * A typed payload must render byte-identically to the equal map payload — {@code -last} and
 * {@code has<Field>} come from one mechanism whatever shape the payload arrives in. The oracle is
 * the shared render-list-separator fixture, whose expected.txt every port renders identically.
 */
public class TypedPayloadRenderTest {

    // ---- Records -------------------------------------------------------------------------
    public record RItem(String name) {}
    public record RTag(String label) {}
    public record RGroup(List<RTag> tags) {}
    public record ROwner(String nick) {}
    public record REntry(String name, String note, ROwner owner) {}
    public record RPayload(List<RItem> items, List<RItem> solo, List<RItem> none, List<RGroup> groups,
                           List<REntry> entries, List<Map<String, Object>> authored) {}

    // ---- Getter-based beans (also the shape of a Kotlin data class: getX() per property) -----
    public static class BItem {
        private final String name;
        public BItem(String name) { this.name = name; }
        public String getName() { return name; }
    }
    public static class BTag {
        private final String label;
        public BTag(String label) { this.label = label; }
        public String getLabel() { return label; }
    }
    public static class BGroup {
        private final List<BTag> tags;
        public BGroup(List<BTag> tags) { this.tags = tags; }
        public List<BTag> getTags() { return tags; }
    }
    public static class BOwner {
        private final String nick;
        public BOwner(String nick) { this.nick = nick; }
        public String getNick() { return nick; }
    }
    public static class BEntry {
        private final String name;
        private final String note;
        private final BOwner owner;
        public BEntry(String name, String note, BOwner owner) { this.name = name; this.note = note; this.owner = owner; }
        public String getName() { return name; }
        public String getNote() { return note; }
        public BOwner getOwner() { return owner; }
    }
    public static class BPayload {
        public List<BItem> getItems() { return List.of(new BItem("a"), new BItem("b"), new BItem("c")); }
        public List<BItem> getSolo() { return List.of(new BItem("only")); }
        public List<BItem> getNone() { return List.of(); }
        public List<BGroup> getGroups() {
            return List.of(new BGroup(List.of(new BTag("x"), new BTag("y"))), new BGroup(List.of(new BTag("z"))));
        }
        public List<BEntry> getEntries() {
            return List.of(new BEntry("a", "x", new BOwner("ann")), new BEntry("b", null, new BOwner("bob")),
                new BEntry("c", "z", new BOwner("cy")));
        }
        public List<Map<String, Object>> getAuthored() { return authored(); }
    }

    private static List<Map<String, Object>> authored() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (String n : List.of("p", "q")) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", n);
            m.put("-last", true);
            out.add(m);
        }
        return out;
    }

    private static Path fixtureDir() {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/render-conformance"))) p = p.getParent();
        return p.resolve("fixtures/render-conformance/render-list-separator");
    }

    private static String read(String file) throws IOException {
        return Files.readString(fixtureDir().resolve(file), StandardCharsets.UTF_8);
    }

    private static String render(String template, Object payload) {
        return new Renderer().render(new RenderRequest(
            template, null, payload, new InMemoryProvider(Map.of()), "text", null, null));
    }

    @Test
    public void recordPayloadRendersTheSharedFixtureByteIdentically() throws IOException {
        RPayload payload = new RPayload(
            List.of(new RItem("a"), new RItem("b"), new RItem("c")),
            List.of(new RItem("only")), List.of(),
            List.of(new RGroup(List.of(new RTag("x"), new RTag("y"))), new RGroup(List.of(new RTag("z")))),
            List.of(new REntry("a", "x", new ROwner("ann")), new REntry("b", null, new ROwner("bob")),
                new REntry("c", "z", new ROwner("cy"))),
            authored());
        assertEquals(read("expected.txt"), render(read("template.mustache"), payload));
    }

    @Test
    public void beanPayloadRendersTheSharedFixtureByteIdentically() throws IOException {
        assertEquals(read("expected.txt"), render(read("template.mustache"), new BPayload()));
    }

    @Test
    public void hasFieldGateWorksOnBeanElementsLikeOnMaps() {
        String tpl = "{{#items}}{{name}}:{{#hasNote}}y{{/hasNote}}{{^hasNote}}n{{/hasNote}} {{/items}}";
        Map<String, Object> viaMaps = Map.of("items", List.of(
            Map.of("name", "a", "note", "x"), Map.of("name", "b", "note", " ")));
        Map<String, Object> viaBeans = Map.of("items", List.of(
            new BEntry("a", "x", null), new BEntry("b", " ", null)));
        assertEquals("a:y b:n ", render(tpl, viaMaps));
        assertEquals(render(tpl, viaMaps), render(tpl, viaBeans));
    }

    @Test
    public void getClassIsNotExposedOnABean() {
        assertEquals("[]", "[" + render("{{class}}{{getClass}}", new BItem("a")) + "]");
    }
}
