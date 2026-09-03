package com.metaobjects.generator.spring;

import com.metaobjects.generator.EmitsPhysicalNameConstants;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.generator.GeneratorRegistryConformanceTest;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * NO MAGIC STRINGS — the Java half of the gate that makes "generated code references the
 * constant" checkable instead of asserted. Port of the TypeScript
 * {@code no-magic-physical-names.test.ts}, the C# {@code NoMagicPhysicalNamesTests}, the
 * Kotlin {@code NoMagicPhysicalNamesTest} and the Python
 * {@code test_no_magic_physical_names.py}.
 *
 * <p>METHOD — a DE-BLINDED fixture. Every physical name below is deliberately impossible
 * for a generator to produce by derivation: it is not the snake_case of its field name,
 * not the pluralization of its object name, and carries a {@code zz_phys_} prefix nothing
 * else in the codebase uses. So a generator that embeds a literal cannot be confused with
 * one that derived the same string by coincidence — if the token appears in a file, that
 * file hard-coded it.</p>
 *
 * <p>Java's answer differs from the ORM-binding ports' and the difference is the POINT of
 * running the gate here rather than reasoning about it — see
 * {@link #the_run_emits_real_output_so_the_clean_result_above_is_not_vacuous()}.</p>
 *
 * <p>ONE category is out of this method's reach in the ports that DO bind an ORM, and it is
 * worth naming rather than leaving a reader to assume otherwise: a RELATIONSHIP-SYNTHESIZED
 * foreign-key column — the column a parent-side {@code relationship.composition
 * @cardinality: many} contributes to the child's table when the child declares no field for
 * it. That name is DERIVED (the relationship's short name + "Id", through the naming
 * strategy), never declared, so there is no physical name to de-blind and nothing for a
 * generator to restate.</p>
 */
public class NoMagicPhysicalNamesTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    // -----------------------------------------------------------------------
    // The de-blinded fixture, kept in step with the other ports' gates.
    // -----------------------------------------------------------------------
    private static final String TABLE = "zz_phys_tbl_alpha";       // NOT pluralize(snake("Customer"))
    private static final String COL_ID = "zz_phys_col_ident";      // NOT snake("id")
    private static final String COL_EMAIL = "zz_phys_col_mail";    // NOT snake("email")
    private static final String COL_FK = "zz_phys_col_owner";      // NOT snake("customerId")
    private static final String ORDER_TABLE = "zz_phys_tbl_beta";  // NOT pluralize(snake("Order"))
    private static final String ORDER_ID = "zz_phys_col_okey";
    private static final String VIEW = "zz_phys_view_gamma";       // NOT "v_" + snake("CustomerSummary")
    private static final String JSONB_COL = "zz_phys_col_blob";
    private static final String VO_MEMBER_COL = "zz_phys_col_road";

    /** Physical names a generator must reference through {@code <Entity>Names} rather than respell. */
    private static final Map<String, String> SHOULD_USE = shouldUse();

    private static Map<String, String> shouldUse() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put(TABLE, "CustomerNames.NAME");
        m.put(COL_ID, "CustomerNames.ID_COLUMN");
        m.put(COL_EMAIL, "CustomerNames.EMAIL_COLUMN");
        m.put(JSONB_COL, "CustomerNames.PROFILE_COLUMN");
        m.put(ORDER_TABLE, "OrderNames.NAME");
        m.put(ORDER_ID, "OrderNames.ID_COLUMN");
        m.put(COL_FK, "OrderNames.CUSTOMER_ID_COLUMN");
        m.put(VIEW, "CustomerSummaryNames.NAME");
        return m;
    }

    /**
     * Physical names this port still spells literally, each with the reason. PINNED, not
     * exempted — {@link #every_physical_name_that_escapes_is_a_declared_known_literal()}
     * asserts the set matches EXACTLY, so a fixed one fails just as loudly as a new escape.
     *
     * <p>Empty, and that is the finding: see the vacuity test's javadoc. {@link #VO_MEMBER_COL}
     * is in the fixture precisely so that claim is tested rather than assumed — it is the
     * column the ORM-binding ports genuinely cannot reach through a constant.</p>
     */
    private static final Set<String> KNOWN_LITERALS = Set.of();

    private static final String MODEL = "{\n"
        + "  \"metadata.root\": { \"package\": \"acme\", \"children\": [\n"
        + "    { \"object.value\": { \"name\": \"Address\", \"children\": [\n"
        + "        { \"field.string\": { \"name\": \"road\", \"@column\": \"" + VO_MEMBER_COL + "\" } }\n"
        + "    ] } },\n"
        + "    { \"object.entity\": { \"name\": \"Customer\", \"children\": [\n"
        + "        { \"source.rdb\":   { \"@table\": \"" + TABLE + "\" } },\n"
        + "        { \"field.long\":   { \"name\": \"id\",    \"@column\": \"" + COL_ID + "\" } },\n"
        + "        { \"field.string\": { \"name\": \"email\", \"@column\": \"" + COL_EMAIL + "\", \"@required\": true } },\n"
        + "        { \"field.object\": { \"name\": \"profile\", \"@column\": \"" + JSONB_COL + "\",\n"
        + "                              \"@objectRef\": \"Address\", \"@storage\": \"jsonb\" } },\n"
        + "        { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"], \"@generation\": \"increment\" } }\n"
        + "    ] } },\n"
        + "    { \"object.projection\": { \"name\": \"CustomerSummary\", \"children\": [\n"
        + "        { \"source.rdb\":   { \"@kind\": \"view\", \"@view\": \"" + VIEW + "\" } },\n"
        + "        { \"field.long\":   { \"name\": \"id\",    \"extends\": \"Customer.id\" } },\n"
        + "        { \"field.string\": { \"name\": \"email\", \"children\": [\n"
        + "            { \"origin.passthrough\": { \"@from\": \"Customer.email\" } } ] } },\n"
        + "        { \"identity.primary\": { \"name\": \"pk\", \"extends\": \"Customer.pk\" } }\n"
        + "    ] } },\n"
        + "    { \"object.entity\": { \"name\": \"Order\", \"children\": [\n"
        + "        { \"source.rdb\":   { \"@table\": \"" + ORDER_TABLE + "\" } },\n"
        + "        { \"field.long\":   { \"name\": \"id\",         \"@column\": \"" + ORDER_ID + "\" } },\n"
        + "        { \"field.long\":   { \"name\": \"customerId\", \"@column\": \"" + COL_FK + "\" } },\n"
        + "        { \"identity.primary\":   { \"name\": \"pk\", \"@fields\": [\"id\"], \"@generation\": \"increment\" } },\n"
        + "        { \"identity.reference\": { \"name\": \"customerRef\", \"@fields\": [\"customerId\"],\n"
        + "                                    \"@references\": \"Customer\" } },\n"
        + "        { \"relationship.association\": { \"name\": \"customer\", \"@cardinality\": \"one\",\n"
        + "                                          \"@objectRef\": \"Customer\" } }\n"
        + "    ] } }\n"
        + "  ] }\n"
        + "}";

    /** A names artifact is the ONE file allowed to spell a physical name literally. */
    private static boolean isNamesArtifact(String path) {
        return path.endsWith("Names.java");
    }

    /**
     * Run every NATIVE generator the registry knows, exactly as a full
     * {@code metaobjects:generate} suite would, and return every emitted file.
     * Registry-driven rather than a hand-listed suite: a generator added later is gated
     * the day it is registered, not the day someone remembers to add it here.
     */
    private Map<String, String> generate() throws Exception {
        Path workspace = tmp.newFolder("ws").toPath();
        Path outDir = tmp.newFolder("out").toPath();
        Path templateRoot = tmp.newFolder("tpl").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "no-magic", MODEL);

        // The `template` generator renders a USER-authored Mustache; write one so the whole
        // registry is runnable. Deliberately trivial and physical-name-free: the declarative
        // data dict (TemplateData) carries no @table/@column at all, so this generator cannot
        // spell a physical name — running it proves the registry row BUILDS, which is the
        // property this suite depends on.
        Path probeTemplate = templateRoot.resolve("no-magic").resolve("probe.mustache");
        Files.createDirectories(probeTemplate.getParent());
        Files.writeString(probeTemplate, "{{name}}\n");

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        args.put("pkgPrefix", "acme.gen");
        // Required by the template/render-helper generators, ignored by the rest; supplying
        // it keeps the whole registry runnable rather than making the suite a hand-picked
        // subset — a subset is how a generator escapes the gate.
        args.put("templateRoot", templateRoot.toString());
        // Required by the entity generator (JavaObjectCodeGenerator), ignored by the rest.
        args.put("type", "class");
        args.put("flavor", "pojoAware");
        // Required by TemplateScopeGenerator (the `template` row), ignored by the rest.
        args.put("templatesDir", templateRoot.toString());
        args.put("template", "no-magic/probe");
        args.put("scope", "perEntity");
        args.put("outputPattern", "template-scope/{Name}.txt");

        List<Generator> suite = new ArrayList<>();
        Set<String> notGenerators = new TreeSet<>();
        for (GeneratorRegistry.GeneratorInfo info : GeneratorRegistry.list().values()) {
            if (info.tier() != GeneratorRegistry.Tier.NATIVE) continue;
            Class<?> impl = Class.forName(info.classname());
            if (!Generator.class.isAssignableFrom(impl)) {
                notGenerators.add(info.stableName());
                continue;
            }
            suite.add((Generator) impl.getDeclaredConstructor().newInstance());
        }
        // A registry entry that cannot be built as a Generator is skipped — but the SET of
        // them is PINNED, because silently dropping entries is how a generator escapes this
        // gate. The pin is GeneratorRegistryConformanceTest.FUSED_NOT_WIRABLE, which owns
        // the question and states the reason; asserting it here too means this suite cannot
        // quietly start covering less than that ruling says it does.
        assertEquals("registry entries that are not Generators",
            new TreeSet<>(GeneratorRegistryConformanceTest.FUSED_NOT_WIRABLE), notGenerators);
        // Derive `useNames` from the suite through the SHIPPED helper — the identical call
        // AbstractMetaDataMojo.buildGenerators makes. Re-implementing it here would leave
        // the gate measuring the test's own logic.
        Map<String, String> runArgs = EmitsPhysicalNameConstants.deriveUseNames(args, suite);
        for (Generator g : suite) {
            g.setArgs(new HashMap<>(runArgs));
            g.execute(loader);
        }

        Map<String, String> tree = new LinkedHashMap<>();
        try (Stream<Path> walk = Files.walk(outDir)) {
            for (Path p : walk.filter(Files::isRegularFile).collect(Collectors.toList())) {
                tree.put(outDir.relativize(p).toString().replace('\\', '/'), Files.readString(p));
            }
        }
        return tree;
    }

    @Test
    public void emits_a_names_artifact_carrying_every_de_blinded_physical_name() throws Exception {
        Map<String, String> tree = generate();
        String all = tree.entrySet().stream()
            .filter(e -> isNamesArtifact(e.getKey()))
            .map(Map.Entry::getValue)
            .collect(Collectors.joining("\n"));
        // Teeth: with no names artifact at all every assertion below passes vacuously.
        assertFalse("no *Names.java emitted — every assertion below would be vacuous", all.isEmpty());

        Set<String> missing = new TreeSet<>();
        for (Map.Entry<String, String> e : SHOULD_USE.entrySet()) {
            if (!all.contains(e.getKey())) {
                missing.add(e.getKey() + " appears in no names artifact — " + e.getValue() + " cannot exist");
            }
        }
        assertEquals(String.join("\n", missing), Set.of(), missing);
    }

    @Test
    public void references_the_constant_everywhere_else_no_generated_file_spells_one_literally() throws Exception {
        Set<String> offenders = new TreeSet<>();
        for (Map.Entry<String, String> file : generate().entrySet()) {
            if (isNamesArtifact(file.getKey())) continue;
            for (Map.Entry<String, String> t : SHOULD_USE.entrySet()) {
                if (file.getValue().contains(t.getKey())) {
                    offenders.add(file.getKey() + ": hard-codes \"" + t.getKey()
                        + "\" — should reference " + t.getValue());
                }
            }
        }
        // Reported as a sorted list rather than a boolean, so a failure enumerates every
        // remaining gap in one run instead of one per fix-and-rerun cycle.
        assertEquals(String.join("\n", offenders), Set.of(), offenders);
    }

    @Test
    public void the_run_emits_real_output_so_the_clean_result_above_is_not_vacuous() throws Exception {
        // The teeth for the test above, adapted to this port.
        //
        // In TypeScript, C# and Kotlin the anti-vacuity assertion is "every constant is
        // REFERENCED by some generated file" — because there, generated code binds an ORM
        // (Drizzle, EF Core, Exposed) and must therefore spell a physical name. Java's
        // generated surface is DTOs, controllers and a repository INTERFACE the consumer
        // implements with their own persistence layer: the physical layer is the adopter's,
        // so there is no generated consumer, and demanding one would mean inventing output
        // nobody asked for.
        //
        // What must still be ruled out is the OTHER way a "no literals" result comes out
        // clean: emitting nothing. So this asserts the run produced substantive per-entity
        // output for every object in the fixture, alongside the names artifacts. If Java ever
        // grows a generator that does bind physical storage, the gate above starts convicting
        // it the day it lands.
        Map<String, String> tree = generate();
        Set<String> nonNames = tree.keySet().stream()
            .filter(p -> !isNamesArtifact(p)).collect(Collectors.toCollection(TreeSet::new));
        for (String expected : List.of("CustomerDto.java", "OrderDto.java", "CustomerRepository.java")) {
            assertTrue("expected " + expected + " among " + nonNames,
                nonNames.stream().anyMatch(p -> p.endsWith("/" + expected) || p.equals(expected)));
        }
        // ...and the names artifacts exist for exactly the three table/view-backed objects
        // (Address is an object.value — no source, so no artifact, per #248).
        Set<String> names = tree.keySet().stream().filter(NoMagicPhysicalNamesTest::isNamesArtifact)
            .map(p -> p.substring(p.lastIndexOf('/') + 1))
            .collect(Collectors.toCollection(TreeSet::new));
        assertEquals(new TreeSet<>(List.of(
            "CustomerNames.java", "CustomerSummaryNames.java", "OrderNames.java")), names);
    }

    @Test
    public void every_physical_name_that_escapes_is_a_declared_known_literal() throws Exception {
        // The exhaustive form, and the strongest statement this gate can make. The map above
        // says what each KNOWN name should do; this says there is nothing ELSE. Every physical
        // name in the fixture is `zz_phys_`-prefixed, so any such token appearing outside a
        // names artifact is a physical name that escaped, whether or not anyone thought to
        // list it. Equality in BOTH directions — a new escape fails, and so does a
        // KNOWN_LITERAL that has quietly been fixed.
        //
        // For Java the expected set is EMPTY, and that is the finding: this port's generated
        // code contains no physical database name anywhere. Not a gap to close — the physical
        // layer is the adopter's repository implementation, and <Entity>Names exists to be
        // referenced BY it.
        Pattern token = Pattern.compile("zz_phys_\\w+");
        Set<String> escaped = new TreeSet<>();
        for (Map.Entry<String, String> file : generate().entrySet()) {
            if (isNamesArtifact(file.getKey())) continue;
            Matcher m = token.matcher(file.getValue());
            while (m.find()) escaped.add(m.group());
        }
        assertEquals(new TreeSet<>(KNOWN_LITERALS), escaped);
    }
}
