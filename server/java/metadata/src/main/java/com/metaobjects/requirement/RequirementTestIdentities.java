package com.metaobjects.requirement;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.validation.SymbolTable;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/**
 * Which tests a requirement ledger yields, what each is called, whether it is skipped, and a
 * fingerprint of the claim it tests (ADR-0057). Everything here is what every language port
 * agrees on and the shared {@code fixtures/requirement-test-identity-conformance/} corpus
 * pins; how a test is WRITTEN is the generator's business and differs per port.
 *
 * <p>Java port of {@code requirementTestIdentities} and its helpers in the TypeScript
 * reference, {@code requirement-walk.ts}. They live here, in the core library beside the
 * walk, rather than in the generator, because an application that owns its generator
 * ({@code mvn metaobjects:eject}) still imports them from the package: an owned copy changes
 * how a test is written and keeps agreeing with every other tool about which tests exist.</p>
 */
public final class RequirementTestIdentities {

    private RequirementTestIdentities() {}

    /** The unit a test stands for when the requirement resolves no target. */
    public static final String NO_UNIT = "*";

    /**
     * The fan-out unit: what one generated test stands for.
     * {@link #CONCERN} (default): one test per distinct {@code <type>.<subType>} a requirement
     * claims. {@link #MEMBER}: one test per distinct {@code implementedBy} reference that
     * resolves, spelt exactly as authored.
     */
    public enum Grain {
        CONCERN("concern"), MEMBER("member");

        private final String text;

        Grain(String text) {
            this.text = text;
        }

        /** The spelling a generator arg or config uses. */
        public String text() {
            return text;
        }

        /**
         * Refuse anything that is not a grain. An arg arrives as a plain string, so a typo
         * would otherwise pick a grain by accident.
         *
         * @throws IllegalArgumentException for any other value
         */
        public static Grain parse(String value) {
            for (Grain g : values()) {
                if (g.text.equals(value)) return g;
            }
            throw new IllegalArgumentException("unknown requirement-test grain "
                + (value == null ? "null" : "\"" + value + "\"") + ": expected \"concern\" or \"member\".");
        }
    }

    /** One generated test. The same record in every language port. */
    public record Identity(String pkg, String path, String unit, String id, String witnessKey,
                           String status, String skip, String digest) {}

    /**
     * What a filter receives; never the node. {@code level} and {@code status} may be
     * {@code null}: an unlevelled architectural requirement has no level, and that is not a
     * number.
     */
    public record View(String subType, Integer level, String status, String path, String pkg,
                       List<String> implementedByTypes) {}

    /** A resolved {@code implementedBy} reference: as authored, the node it names, its concern. */
    public record Target(String ref, MetaData node, String concern) {}

    /** One requirement, projected for a filter, with the targets its references resolved to. */
    public record Walked(MetaRequirement node, View view, List<Target> targets) {}

    /** {@code <type>.<subType>}: the key a renderer or filter reasons about. */
    public static String concernOf(MetaData node) {
        return node.getType() + "." + node.getSubType();
    }

    /**
     * RECOMMENDATION, not a rule: functional requirements at or below the link floor.
     * Architectural requirements are excluded by default because {@code verify}'s
     * universality check already proves them structurally. It is overridable.
     */
    public static boolean defaultFilter(View view) {
        return MetaRequirement.SUBTYPE_FUNCTIONAL.equals(view.subType())
            && (view.level() == null ? 0 : view.level()) >= MetaRequirement.LINK_FLOOR_LEVEL;
    }

    // ------------------------------------------------------------------
    // the walk
    // ------------------------------------------------------------------

    /**
     * Every requirement in walk order with its view and resolved targets. An
     * {@code implementedBy} reference that does not resolve is skipped rather than reported:
     * its severity depends on {@code @status} and belongs to {@code verify}, and codegen must
     * not fail a build over a diagnostic another command owns.
     */
    public static List<Walked> walk(MetaRoot root) {
        SymbolTable symbols = SymbolTable.build(root);
        List<Walked> out = new ArrayList<>();
        for (RequirementCheck.Addressed a : RequirementCheck.collectAddressed(root)) {
            MetaRequirement node = a.node();
            // One effective package, shared with the gate: the node's own, else the nearest
            // enclosing node's, else "".
            String pkg = RequirementCheck.effectivePackage(node);
            List<Target> targets = new ArrayList<>();
            for (String ref : node.getImplementedBy()) {
                MetaData target = RequirementClaims.resolveClaim(root, symbols, ref, pkg);
                if (target != null) targets.add(new Target(ref, target, concernOf(target)));
            }
            LinkedHashSet<String> concerns = new LinkedHashSet<>();
            for (Target t : targets) concerns.add(t.concern());
            out.add(new Walked(node,
                new View(node.getSubType(), node.getLevel(), node.getStatus(), a.path(), pkg, List.copyOf(concerns)),
                targets));
        }
        return out;
    }

    /**
     * A requirement's targets grouped by fan-out unit under the grain, one entry per test, in
     * first-seen order. Under {@link Grain#MEMBER} a reference authored twice is one test and
     * the bare and qualified spellings of one node are two: the unit is the reference as
     * written. In both grains a requirement resolving NO target still yields exactly one
     * entry, keyed {@link #NO_UNIT}: the link floor forbids {@code implementedBy} below L4,
     * so every L1 to L3 requirement resolves nothing, and an application that chooses to
     * cover one would otherwise get silence.
     */
    public static Map<String, List<Target>> units(Walked walked, Grain grain) {
        Map<String, List<Target>> units = new LinkedHashMap<>();
        for (Target t : walked.targets()) {
            String key = grain == Grain.MEMBER ? t.ref() : t.concern();
            if (grain == Grain.MEMBER) {
                units.putIfAbsent(key, new ArrayList<>(List.of(t)));
            } else {
                units.computeIfAbsent(key, k -> new ArrayList<>()).add(t);
            }
        }
        if (units.isEmpty()) units.put(NO_UNIT, new ArrayList<>());
        return units;
    }

    /** The qualified address: {@code <package>::<path>}, or the bare path when the package is empty. */
    public static String addressOf(String pkg, String path) {
        return pkg.isEmpty() ? path : pkg + MetaData.PKG_SEPARATOR + path;
    }

    /** The identity of the one test {@code unit} stands for (a key of {@link #units}). */
    public static Identity identity(Walked walked, String unit) {
        View view = walked.view();
        String address = addressOf(view.pkg(), view.path());
        // Derived from the loader's status list rather than naming the two skipped statuses:
        // a status that does not claim the capability works right now is skipped by
        // construction, so a status added later cannot be left failing by omission.
        boolean skips = view.status() != null
            && !MetaRequirement.STATUSES_REQUIRING_LIVE_NODES.contains(view.status());
        return new Identity(view.pkg(), view.path(), unit, address + " [" + unit + "]",
            witnessKeyOf(address, unit), view.status(), skips ? view.status() : null, digest(walked.node()));
    }

    /**
     * Every test the generator would emit, sorted by id (UTF-16 code units, not a locale
     * collation).
     *
     * @param grain  {@code null} means {@link Grain#CONCERN}
     * @param filter {@code null} means {@link #defaultFilter}; a filter REPLACES the default
     */
    public static List<Identity> identities(MetaRoot root, Grain grain, RequirementTestFilter filter) {
        Grain g = grain == null ? Grain.CONCERN : grain;
        RequirementTestFilter f = filter == null ? RequirementTestIdentities::defaultFilter : filter;
        List<Identity> out = new ArrayList<>();
        for (Walked walked : walk(root)) {
            if (!f.include(walked.view())) continue;
            for (String unit : units(walked, g).keySet()) out.add(identity(walked, unit));
        }
        out.sort((a, b) -> a.id().compareTo(b.id()));
        return out;
    }

    // ------------------------------------------------------------------
    // witness key
    // ------------------------------------------------------------------

    /** Every maximal run of characters outside ASCII {@code [A-Za-z0-9]} becomes one {@code _}. */
    private static String mangle(String s) {
        return s.replaceAll("[^A-Za-z0-9]+", "_");
    }

    /**
     * An identifier-safe key for one test: {@code req_<address>}, then {@code __<unit>} unless
     * the requirement resolves no target. Mangling is lossy ({@code Orders.Recorded} and
     * {@code Orders_Recorded} give one key), which is what {@link #witnessKeyCollisions}
     * reports. The class is ASCII and excludes {@code _}; {@code Character.isLetterOrDigit}
     * keeps accented letters and is wrong.
     */
    public static String witnessKeyOf(String qualifiedAddress, String unit) {
        String base = "req_" + mangle(qualifiedAddress);
        return NO_UNIT.equals(unit) ? base : base + "__" + mangle(unit);
    }

    /** Pairs of ids that share a witness key, each pair and the list sorted. */
    public static List<String[]> witnessKeyCollisions(List<Identity> tests) {
        Map<String, List<String>> byKey = new LinkedHashMap<>();
        for (Identity t : tests) byKey.computeIfAbsent(t.witnessKey(), k -> new ArrayList<>()).add(t.id());
        List<String[]> pairs = new ArrayList<>();
        for (List<String> ids : byKey.values()) {
            List<String> sorted = new ArrayList<>(ids);
            sorted.sort(String::compareTo);
            for (int i = 0; i < sorted.size(); i++) {
                for (int j = i + 1; j < sorted.size(); j++) pairs.add(new String[]{sorted.get(i), sorted.get(j)});
            }
        }
        pairs.sort((a, b) -> {
            int c = a[0].compareTo(b[0]);
            return c != 0 ? c : a[1].compareTo(b[1]);
        });
        return pairs;
    }

    // ------------------------------------------------------------------
    // digest
    // ------------------------------------------------------------------

    private static final String DIGEST_VERSION = "requirement-digest/v1";

    /** {@code <name> <byte length>\n<value>\n}: length-prefixed, so no value can be confused with the field after it. */
    private static String digestField(String name, String value) {
        return name + " " + value.getBytes(StandardCharsets.UTF_8).length + "\n" + value + "\n";
    }

    /** {@code \r\n} and a lone {@code \r} become {@code \n}; an absent value is empty. */
    private static String prose(String value) {
        return value == null ? "" : value.replaceAll("\r\n?", "\n");
    }

    /**
     * {@code requirement-digest/v1}: lowercase hex SHA-256 of the requirement's subtype, level,
     * status, statement, counterexample and {@code implementedBy} list. It answers "did the
     * claim change", not "did the entry move": the name, the package, the title, the notes,
     * the disposition, the tracking references and nested requirements are left out. Every
     * value is the EFFECTIVE one (resolving accessors, ADR-0039), so a requirement inheriting
     * its statement through {@code extends} hashes what it effectively says.
     */
    public static String digest(MetaRequirement node) {
        Integer level = node.getLevel();
        List<String> refs = node.getImplementedBy();
        StringBuilder text = new StringBuilder();
        text.append(DIGEST_VERSION).append('\n')
            .append(digestField("subType", node.getSubType()))
            .append(digestField("level", level == null ? "" : String.valueOf(level)))
            .append(digestField("status", node.getStatus() == null ? "" : node.getStatus()))
            .append(digestField("statement", prose(node.getStatement())))
            .append(digestField("counterexample", prose(node.getCounterexample())))
            .append("implementedBy ").append(refs.size()).append('\n');
        for (String ref : refs) text.append(digestField("ref", ref));
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(text.toString().getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required of every Java platform", e);
        }
    }
}
