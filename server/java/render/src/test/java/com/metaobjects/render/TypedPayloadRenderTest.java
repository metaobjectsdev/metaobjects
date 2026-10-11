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

    // ---- The overlay adds names; it never takes any away -----------------------------------

    /** A value with its own string form. */
    public static final class Money {
        private final long cents;
        private final String currency;
        public Money(long cents, String currency) { this.cents = cents; this.currency = currency; }
        public long getCents() { return cents; }
        public String getCurrency() { return currency; }
        @Override public String toString() { return currency + " " + cents + "c"; }
    }

    /** Every read of {@link Line#getExploding()}, counted before it throws. */
    static final java.util.concurrent.atomic.AtomicInteger EXPLODING_READS = new java.util.concurrent.atomic.AtomicInteger();

    public static class Line {
        String sku;                                  // package-private field, no getter
        private final Money price;
        Line(String sku, Money price) { this.sku = sku; this.price = price; }
        public String name() { return "name:" + sku; }   // fluent accessor
        public Money getPrice() { return price; }
        public String getExploding() {
            EXPLODING_READS.incrementAndGet();
            throw new IllegalStateException("read a member the template never names");
        }
    }

    public static class Order {
        public String getId() { return "o-1"; }
        public Money getTotal() { return new Money(1250, "USD"); }
        public List<Line> getLines() {
            return List.of(new Line("a", new Money(500, "USD")), new Line("b", new Money(750, "USD")));
        }
        public String summary() { return "order " + getId(); }   // method resolved by exact name
        @Override public String toString() { return "Order[" + getId() + "]"; }
    }

    public static class Basket {
        public Money getTotal() { return new Money(1250, "USD"); }
        public List<Line> getLines() { return new Order().getLines(); }
        public List<Order> getOrders() { return List.of(new Order()); }
    }

    /** The engine with no MetaObjects view at all: what a typed payload rendered before. */
    private static String renderWithBareEngine(String template, Object payload) throws IOException {
        java.io.StringWriter out = new java.io.StringWriter();
        new com.github.mustachejava.DefaultMustacheFactory()
            .compile(new java.io.StringReader(template), "bare").execute(out, payload).flush();
        return out.toString();
    }

    @Test
    public void methodFluentAccessorAndNonPrivateFieldStillResolve() {
        assertEquals("order o-1|a=name:a;b=name:b;",
            render("{{summary}}|{{#lines}}{{sku}}={{name}};{{/lines}}", new Order()));
    }

    @Test
    public void aValueRendersThroughItsOwnStringForm() {
        assertEquals("USD 1250c|USD 500c;USD 750c;|Order[o-1]",
            render("{{total}}|{{#lines}}{{price}};{{/lines}}|{{#orders}}{{.}}{{/orders}}", new Basket()));
    }

    @Test
    public void aMemberTheTemplateNeverNamesIsNeverRead() {
        // Line.getExploding() counts each read and then throws. The template does not name it.
        // The count is what proves laziness: a view that read every member up front and
        // swallowed the failure would still render "a,b".
        EXPLODING_READS.set(0);
        assertEquals("a,b", render("{{#lines}}{{sku}}{{^-last}},{{/-last}}{{/lines}}", new Order()));
        assertEquals(0, EXPLODING_READS.get());
    }

    @Test
    public void aTemplateWithoutDerivedNamesRendersExactlyAsTheBareEngineDoes() throws IOException {
        String template = "{{id}} {{summary}} {{total}} {{total.cents}} {{toString}}"
            + "{{#lines}} [{{sku}} {{name}} {{price}} {{price.currency}} {{id}}]{{/lines}}"
            + "{{#total}} {{currency}}{{/total}}{{^missing}} none{{/missing}}";
        String expected = renderWithBareEngine(template, new Order());
        assertEquals(
            "o-1 order o-1 USD 1250c 1250 Order[o-1] [a name:a USD 500c USD o-1] [b name:b USD 750c USD o-1] USD none",
            expected);
        assertEquals(expected, render(template, new Order()));
    }

    // ---- A primitive array is the engine's own list, in every payload shape ------------------

    public record RScores(int[] scores) {}

    public static class BScores {
        private final int[] scores;
        public BScores(int... scores) { this.scores = scores; }
        public int[] getScores() { return scores; }
    }

    /**
     * The oracle is the Mustache spec: a section over a list renders its body once per element,
     * with {@code {{.}}} the element; an inverted section renders for an empty list. A view that
     * wrapped the array rendered the body once, with the array's identity string.
     */
    @Test
    public void aSectionOverAPrimitiveArrayRendersPerElementInEveryPayloadShape() {
        String template = "{{#scores}}{{.}},{{/scores}}";
        assertEquals("1,2,3,", render(template, Map.of("scores", new int[] {1, 2, 3})));
        assertEquals("1,2,3,", render(template, new RScores(new int[] {1, 2, 3})));
        assertEquals("1,2,3,", render(template, new BScores(1, 2, 3)));
    }

    @Test
    public void anInvertedSectionOverAnEmptyPrimitiveArrayRendersItsBody() {
        String template = "{{^scores}}none{{/scores}}";
        assertEquals("none", render(template, Map.of("scores", new int[0])));
        assertEquals("none", render(template, new RScores(new int[0])));
        assertEquals("none", render(template, new BScores()));
    }

    @Test
    public void derivedNamesSitOnTopOfATypedObjectsOwnMembers() {
        assertEquals("name:a + name:b has-id no-missing",
            render("{{#hasLines}}{{#lines}}{{name}}{{^-last}} + {{/-last}}{{/lines}}{{/hasLines}}"
                + "{{#hasId}} has-id{{/hasId}}{{^hasMissing}} no-missing{{/hasMissing}}", new Order()));
    }
}
