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
import java.util.Comparator;
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
 * <p>WHAT THE FIXTURE MUST CONTAIN is the other half, and the half that failed first. This
 * gate ran green for its whole life over a fixture with no TPH pair, no {@code field.enum},
 * no {@code identity.secondary}, no {@code index.lookup}, no callable source, no
 * {@code @schema}, no {@code @isArray} and no abstract base. Every one of those shapes is
 * handled on its own code path — in the names generator's fragment/TPH passes here, in the
 * ORM binding in the ports that have one — so the green meant "the paths we happened to
 * model are clean", a much smaller claim than the one the gate's name makes. A gate is only
 * ever as wide as its fixture, so treat the model below as the load-bearing part of this
 * file and add to it whenever a generator grows a new path.</p>
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
    private static final String VO_COL = "zz_phys_col_street";
    private static final String JSONB_COL = "zz_phys_col_blob";    // a single-jsonb-column value object
    private static final String VO_MEMBER_COL = "zz_phys_col_road";
    private static final String WT_TABLE = "zz_phys_tbl_delta";    // a write-through entity's table...
    private static final String WT_VIEW = "zz_phys_view_delta";    // ...and its replica view
    private static final String WT_ID = "zz_phys_col_acct";        // the write-through entity's key column

    // --- Shapes the original fixture did not contain -----------------------------------
    // Each block below exists because a generator handles it on a DIFFERENT code path from
    // the plain-entity one above, and a path no fixture reaches is a path this gate cannot
    // speak for. In THIS port the paths are the names generator's own: the abstract-base
    // FRAGMENT class, the TPH subtype class that `extends` its base's, the SCHEMA slot, and
    // the storedProc kind's physical-name alias.
    private static final String WIDGET_TABLE = "zz_phys_tbl_wid";  // the index/enum/schema entity's table
    private static final String TPH_TABLE = "zz_phys_tbl_veh";     // a TPH discriminator base's table
    private static final String TPH_ID = "zz_phys_col_vid";
    private static final String TPH_DISC = "zz_phys_col_kind";     // the discriminator column
    private static final String TPH_SUB_COL = "zz_phys_col_doors"; // a SUBTYPE's own column, folded into the base table
    private static final String SCHEMA = "zz_phys_sch_one";        // @schema on a source.rdb
    private static final String ENUM_COL = "zz_phys_col_stat";     // a string-backed field.enum
    private static final String ENUM_INT_COL = "zz_phys_col_grad"; // an int-backed field.enum (@intValueMap)
    private static final String ARRAY_COL = "zz_phys_col_tags";    // an @isArray field
    private static final String ALT_COL = "zz_phys_col_alt";       // the column an identity.secondary keys on
    private static final String SEC_INDEX = "zz_phys_idx_sec";     // an identity.secondary's own name
    private static final String LKP_INDEX = "zz_phys_idx_lkp";     // an index.lookup's own name
    private static final String ABS_COL = "zz_phys_col_bid";       // a column declared on an ABSTRACT base
    private static final String PROC = "zz_phys_proc_alpha";       // a storedProc source's physical name
    private static final String PROC_ARG_COL = "zz_phys_col_since";
    private static final String PROC_OUT_COL = "zz_phys_col_total";

    /**
     * How a physical name reaches generated output today.
     *
     * <p>The three non-{@link #CONSTANT} values are PINNED, not exempted: the gate asserts
     * the condition each one names is still true, so the day a generator starts referencing
     * a constant instead, the pin fails and says "promote it". A known gap that stops being
     * a gap without anyone noticing is how a ledger rots.</p>
     *
     * <p>They are kept APART because they are not the same claim, and collapsing them is how
     * a defect acquires the standing of a ruling. A {@link #KNOWN_LITERAL} is STRUCTURAL —
     * there is no constant to reference, and none should be expected. An {@link #ESCAPE} is
     * a DEFECT — the constant exists, in an artifact this very run emits, and a generator
     * spelled the name again anyway; every such row is additionally required to have a
     * REACHABLE constant, so no row can sit here claiming a fix is impossible when it is
     * merely undone. A {@link #DROPPED} name is the failure mode the literal-scan is BLIND
     * to: an escape spells a name twice, a dropped name is spelled ZERO times — the artifact
     * carries it, no generator reads it, and the binding silently takes a default instead.
     * Every "does a file contain this literal" assertion passes for it.</p>
     *
     * <p>THIS PORT'S ADAPTATION, stated rather than left implicit. Java's generated surface
     * is DTOs, controllers and a repository INTERFACE the adopter implements with their own
     * persistence layer; nothing generated binds a table or a column, so nothing generated
     * READS {@code <Entity>Names} either. {@link #CONSTANT} here therefore means "carried
     * by the names artifact and spelled literally nowhere else" — the "some file references
     * it" half the other ports assert is replaced by the vacuity test, which proves the run
     * emitted real per-object output rather than nothing. By the same token {@link #ESCAPE}
     * and {@link #DROPPED} are both EXPECTED EMPTY: a port that generates no binding can
     * neither respell a physical name nor bind a default in its place. The two values, and
     * the two tests that pin them, exist so that the day Java grows a generator that DOES
     * bind storage, the vocabulary is already here and the pins bite that day rather than
     * after someone remembers to add them. A non-empty escape set on this port is a
     * FINDING, not a ledger entry.</p>
     */
    private enum Reach {
        /** Travels as an {@code <Entity>Names} constant; appears literally nowhere else. */
        CONSTANT,
        /** STRUCTURAL: no constant exists, and none should be expected. Pinned, not exempted. */
        KNOWN_LITERAL,
        /** A DEFECT: the constant exists in an artifact this run emits, and a generator spelled the name again. */
        ESCAPE,
        /** Carried by the artifact, read by no generator — the binding silently takes a default. Spelled zero times. */
        DROPPED,
    }

    /** One de-blinded token, with the constant a generator should have referenced. */
    private record Token(String literal, String shouldUse, Reach reach, String why) {
        static Token constant(String literal, String shouldUse) {
            return new Token(literal, shouldUse, Reach.CONSTANT, "");
        }
    }

    /**
     * Every de-blinded token that has a slot in a names artifact, with the constant that
     * carries it. Java member names are SCREAMING_SNAKE: {@code SpringNamesGenerator.namesMember}
     * is {@code toSnakeCase(field).toUpperCase()} + {@code _COLUMN}, so {@code customerId}
     * becomes {@code CUSTOMER_ID_COLUMN} — derived from what the artifact ACTUALLY emits, not
     * from another port's spelling (C# Pascal-cases the first character only, so a member
     * collision that fires on the JVM does not fire there and vice versa).
     */
    private static final List<Token> TOKENS = List.of(
        Token.constant(TABLE, "CustomerNames.NAME"),
        Token.constant(COL_ID, "CustomerNames.ID_COLUMN"),
        Token.constant(COL_EMAIL, "CustomerNames.EMAIL_COLUMN"),
        Token.constant(VO_COL, "CustomerNames.STREET_COLUMN"),
        Token.constant(JSONB_COL, "CustomerNames.PROFILE_COLUMN"),
        Token.constant(ORDER_TABLE, "OrderNames.NAME"),
        Token.constant(ORDER_ID, "OrderNames.ID_COLUMN"),
        Token.constant(COL_FK, "OrderNames.CUSTOMER_ID_COLUMN"),
        Token.constant(VIEW, "CustomerSummaryNames.NAME"),
        Token.constant(WT_TABLE, "AccountNames.NAME"),
        Token.constant(WT_ID, "AccountNames.ID_COLUMN"),

        // --- TPH: the subtype's names class `extends` the base's and declares only its own
        // column; KIND/NAME come from the base by static inheritance, never restated.
        Token.constant(TPH_TABLE, "VehicleNames.NAME"),
        Token.constant(TPH_ID, "VehicleNames.ID_COLUMN"),
        Token.constant(TPH_DISC, "VehicleNames.KIND_COLUMN"),
        Token.constant(TPH_SUB_COL, "CarNames.DOORS_COLUMN"),

        // --- the enum / index / schema / abstract-base entity.
        Token.constant(WIDGET_TABLE, "WidgetNames.NAME"),
        Token.constant(ENUM_COL, "WidgetNames.STATUS_COLUMN"),
        Token.constant(ENUM_INT_COL, "WidgetNames.GRADE_COLUMN"),
        Token.constant(ARRAY_COL, "WidgetNames.TAGS_COLUMN"),
        Token.constant(ALT_COL, "WidgetNames.ALT_COLUMN"),
        // Declared on the abstract base's FRAGMENT class (AbstractKeyedNames) and reached
        // through WidgetNames by static inheritance — the one sanctioned own-accessor use
        // (ADR-0039): the child states its own columns and inherits the rest.
        Token.constant(ABS_COL, "WidgetNames.ID_COLUMN"),
        // CONSTANT, not DROPPED, and the distinction is this port's whole ruling: in the
        // ORM-binding ports `@schema` reaches the artifact and NO binding reads it, so the
        // table lands in the default schema — a dropped name. Here no generated code binds
        // a table at all, so there is no binding to take a default; the SCHEMA slot is
        // carried for the adopter's persistence layer like every other constant.
        //
        // Stated plainly: this is a RULING, not a measurement. Mechanically the DROPPED pin
        // (carried by the artifact, referenced by nothing) is satisfied by this row — and by
        // EVERY row on this port, since nothing generated references any constant. Relabel
        // it DROPPED and the gate stays green. The label records which port is being
        // described, not something the test can tell apart here.
        Token.constant(SCHEMA, "WidgetNames.SCHEMA"),

        // --- the callable (stored procedure): the storedProc kind's physical-name alias is
        // `@proc`, a different resolver step from `@table`/`@view`.
        Token.constant(PROC, "ProcOutNames.NAME"),
        Token.constant(PROC_OUT_COL, "ProcOutNames.TOTAL_COLUMN")
    );

    /**
     * Physical names in the fixture that have NO slot in any names artifact, each with the
     * reason — the port-adapted form of the TypeScript gate's {@code knownLiteral} rows.
     * There they are PINNED as still-spelled-literally by the ORM binding; here nothing
     * generated binds, so they are spelled by nothing and cannot be pinned that way. What
     * CAN be pinned is the structural half of the claim: none of them is carried by a names
     * artifact today. The day the artifact grows an index or replica-view slot, that pin
     * fails and says "give it a row" — the same self-extinguishing shape as every other
     * ledger in this repo.
     */
    private static final Map<String, String> NO_SLOT = Map.of(
        WT_VIEW, "A write-through entity has TWO physical names; <Entity>Names carries the "
            + "PRIMARY source's only (resolveObjectNames). The replica view has no slot.",
        SEC_INDEX, "An index's database name IS its metamodel `name` — an identity.secondary "
            + "has no `@column`-style physical spelling to diverge from. No index slot exists.",
        LKP_INDEX, "As SEC_INDEX — an index.lookup's database name is its metamodel `name`.",
        VO_MEMBER_COL, "A member of an object.value: no source, so no <Vo>Names (#248). It "
            + "reaches output only through the owning entity's single jsonb column.",
        PROC_ARG_COL, "A member of the callable's @parameterRef value object: no source, so "
            + "no <Vo>Names, and a callable binds its arguments POSITIONALLY."
    );

    /**
     * The model, as a text block: the coverage script
     * ({@code scripts/check-no-magic-gate-coverage.sh}) greps every port's fixture for the
     * QUOTED metamodel tokens it must model, and a {@code \"}-escaped Java string never
     * contains {@code "object.value"} as a substring — every closing quote is preceded by a
     * backslash. A text block is quoted the way every other port's fixture is.
     *
     * <p>Placeholders are {@code ${NAME}} and filled by {@link #fill}: a text block does not
     * interpolate, and the physical names must stay single-sourced in the constants above so
     * a token and the model can never disagree about a spelling.</p>
     */
    private static final String MODEL = fill("""
        {
          "metadata.root": { "package": "acme", "children": [
            { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "road", "@column": "${VO_MEMBER_COL}" } }
            ] } },
            { "object.entity": { "name": "Customer", "children": [
                { "source.rdb":   { "@table": "${TABLE}" } },
                { "field.long":   { "name": "id",    "@column": "${COL_ID}" } },
                { "field.string": { "name": "email", "@column": "${COL_EMAIL}", "@required": true } },
                { "field.string": { "name": "street", "@column": "${VO_COL}" } },
                { "field.object": { "name": "profile", "@column": "${JSONB_COL}",
                                    "@objectRef": "Address", "@storage": "jsonb" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.projection": { "name": "CustomerSummary", "children": [
                { "source.rdb":   { "@kind": "view", "@view": "${VIEW}" } },
                { "field.long":   { "name": "id",    "extends": "Customer.id" } },
                { "field.string": { "name": "email", "children": [
                    { "origin.passthrough": { "@from": "Customer.email" } } ] } },
                { "identity.primary": { "name": "pk", "extends": "Customer.pk" } }
            ] } },
            { "object.entity": { "name": "Order", "children": [
                { "source.rdb":   { "@table": "${ORDER_TABLE}" } },
                { "field.long":   { "name": "id",         "@column": "${ORDER_ID}" } },
                { "field.long":   { "name": "customerId", "@column": "${COL_FK}" } },
                { "identity.primary":   { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                { "identity.reference": { "name": "customerRef", "@fields": ["customerId"],
                                          "@references": "Customer" } },
                { "relationship.association": { "name": "customer", "@cardinality": "one",
                                                "@objectRef": "Customer" } }
            ] } },
            { "object.entity": { "name": "AbstractKeyed", "abstract": true, "children": [
                { "field.long": { "name": "id", "@column": "${ABS_COL}" } }
            ] } },
            { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
                { "source.rdb":   { "@table": "${TPH_TABLE}" } },
                { "field.long":   { "name": "id",   "@column": "${TPH_ID}" } },
                { "field.string": { "name": "kind", "@column": "${TPH_DISC}" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Car", "extends": "Vehicle", "@discriminatorValue": "Car", "children": [
                { "field.int": { "name": "doors", "@column": "${TPH_SUB_COL}" } }
            ] } },
            { "object.entity": { "name": "Widget", "extends": "AbstractKeyed", "children": [
                { "source.rdb":   { "@table": "${WIDGET_TABLE}", "@schema": "${SCHEMA}" } },
                { "field.enum":   { "name": "status", "@column": "${ENUM_COL}", "@values": ["OPEN", "SHUT"] } },
                { "field.enum":   { "name": "grade",  "@column": "${ENUM_INT_COL}", "@values": ["LO", "HI"],
                                    "@intValueMap": { "LO": 1, "HI": 2 } } },
                { "field.string": { "name": "tags", "isArray": true, "@column": "${ARRAY_COL}" } },
                { "field.string": { "name": "alt", "@column": "${ALT_COL}" } },
                { "identity.primary":   { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                { "identity.secondary": { "name": "${SEC_INDEX}", "@fields": ["alt"] } },
                { "index.lookup":       { "name": "${LKP_INDEX}", "@fields": ["status"] } }
            ] } },
            { "object.value": { "name": "ProcArgs", "children": [
                { "field.long": { "name": "since", "@column": "${PROC_ARG_COL}" } }
            ] } },
            { "object.projection": { "name": "ProcOut", "children": [
                { "source.rdb": { "@kind": "storedProc", "@proc": "${PROC}", "@parameterRef": "ProcArgs" } },
                { "field.long": { "name": "total", "@column": "${PROC_OUT_COL}" } }
            ] } },
            { "object.entity": { "name": "Account", "children": [
                { "source.rdb": { "@table": "${WT_TABLE}", "@role": "primary" } },
                { "source.rdb": { "@kind": "view", "@view": "${WT_VIEW}", "@role": "replica" } },
                { "field.long": { "name": "id", "@column": "${WT_ID}" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """);

    private static String fill(String template) {
        Map<String, String> values = new LinkedHashMap<>();
        values.put("TABLE", TABLE);
        values.put("COL_ID", COL_ID);
        values.put("COL_EMAIL", COL_EMAIL);
        values.put("COL_FK", COL_FK);
        values.put("ORDER_TABLE", ORDER_TABLE);
        values.put("ORDER_ID", ORDER_ID);
        values.put("VIEW", VIEW);
        values.put("VO_COL", VO_COL);
        values.put("JSONB_COL", JSONB_COL);
        values.put("VO_MEMBER_COL", VO_MEMBER_COL);
        values.put("WT_TABLE", WT_TABLE);
        values.put("WT_VIEW", WT_VIEW);
        values.put("WT_ID", WT_ID);
        values.put("WIDGET_TABLE", WIDGET_TABLE);
        values.put("TPH_TABLE", TPH_TABLE);
        values.put("TPH_ID", TPH_ID);
        values.put("TPH_DISC", TPH_DISC);
        values.put("TPH_SUB_COL", TPH_SUB_COL);
        values.put("SCHEMA", SCHEMA);
        values.put("ENUM_COL", ENUM_COL);
        values.put("ENUM_INT_COL", ENUM_INT_COL);
        values.put("ARRAY_COL", ARRAY_COL);
        values.put("ALT_COL", ALT_COL);
        values.put("SEC_INDEX", SEC_INDEX);
        values.put("LKP_INDEX", LKP_INDEX);
        values.put("ABS_COL", ABS_COL);
        values.put("PROC", PROC);
        values.put("PROC_ARG_COL", PROC_ARG_COL);
        values.put("PROC_OUT_COL", PROC_OUT_COL);
        String out = template;
        for (Map.Entry<String, String> e : values.entrySet()) {
            out = out.replace("${" + e.getKey() + "}", e.getValue());
        }
        // An unfilled placeholder would load as a physical name spelled `${X}` and pass every
        // literal scan below for the wrong reason.
        if (out.contains("${")) {
            throw new IllegalStateException("unfilled placeholder in the no-magic model: " + out);
        }
        return out;
    }

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
        // A gate whose fixture the loader would reject proves nothing. The strict loader
        // throws on most defects; this catches the ones a phase records instead.
        assertEquals("the no-magic fixture must load clean", List.of(), loader.getErrors());

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

    private static String namesBody(Map<String, String> tree) {
        return tree.entrySet().stream()
            .filter(e -> isNamesArtifact(e.getKey()))
            .map(Map.Entry::getValue)
            .collect(Collectors.joining("\n"));
    }

    private static String consumerBody(Map<String, String> tree) {
        return tree.entrySet().stream()
            .filter(e -> !isNamesArtifact(e.getKey()))
            .map(Map.Entry::getValue)
            .collect(Collectors.joining("\n"));
    }

    @Test
    public void emits_a_names_artifact_carrying_every_de_blinded_physical_name() throws Exception {
        Map<String, String> tree = generate();
        String all = namesBody(tree);
        // Teeth: with no names artifact at all every assertion below passes vacuously.
        assertFalse("no *Names.java emitted — every assertion below would be vacuous", all.isEmpty());

        Set<String> missing = new TreeSet<>();
        for (Token t : TOKENS) {
            if (t.reach() == Reach.KNOWN_LITERAL) continue;
            if (!all.contains(t.literal())) {
                missing.add(t.literal() + " appears in no names artifact — " + t.shouldUse() + " cannot exist");
            }
        }
        assertEquals(String.join("\n", missing), Set.of(), missing);
    }

    @Test
    public void references_the_constant_everywhere_else_no_generated_file_spells_one_literally() throws Exception {
        // A declared escape can CONTAIN a constant's literal as a substring, so the declared
        // literals are masked first — longest first, so a composite is dismantled before the
        // shorter name it wraps could be reported as a standalone hit it is not. With this
        // port's escape set empty the mask is a no-op today; it is here so that a future
        // escape is reported against exactly one row rather than three.
        List<String> declared = TOKENS.stream()
            .filter(t -> t.reach() == Reach.ESCAPE || t.reach() == Reach.KNOWN_LITERAL)
            .map(Token::literal)
            .sorted(Comparator.comparingInt(String::length).reversed())
            .collect(Collectors.toList());
        Set<String> offenders = new TreeSet<>();
        for (Map.Entry<String, String> file : generate().entrySet()) {
            if (isNamesArtifact(file.getKey())) continue;
            String body = file.getValue();
            for (String lit : declared) body = body.replace(lit, "");
            for (Token t : TOKENS) {
                if (t.reach() != Reach.CONSTANT) continue;
                if (body.contains(t.literal())) {
                    offenders.add(file.getKey() + ": hard-codes \"" + t.literal()
                        + "\" — should reference " + t.shouldUse());
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
        for (String expected : List.of(
                "CustomerDto.java", "OrderDto.java", "CustomerRepository.java",
                // The shapes the fixture grew: each must produce real output, or the widened
                // fixture measures nothing new.
                "VehicleDto.java", "CarDto.java", "WidgetDto.java", "AccountDto.java")) {
            assertTrue("expected " + expected + " among " + nonNames,
                nonNames.stream().anyMatch(p -> p.endsWith("/" + expected) || p.equals(expected)));
        }
        // ...and the names artifacts exist for exactly the sourced objects plus the ONE
        // abstract base a sourced object extends (its fragment). Address and ProcArgs are
        // object.values — no source, so no artifact, per #248; the TPH subtype gets its own
        // class because it declares a column of its own.
        Set<String> names = tree.keySet().stream().filter(NoMagicPhysicalNamesTest::isNamesArtifact)
            .map(p -> p.substring(p.lastIndexOf('/') + 1))
            .collect(Collectors.toCollection(TreeSet::new));
        assertEquals(new TreeSet<>(List.of(
            "AbstractKeyedNames.java", "AccountNames.java", "CarNames.java", "CustomerNames.java",
            "CustomerSummaryNames.java", "OrderNames.java", "ProcOutNames.java", "VehicleNames.java",
            "WidgetNames.java")), names);
    }

    @Test
    public void every_physical_name_that_escapes_is_a_declared_known_literal() throws Exception {
        // The exhaustive form, and the strongest statement this gate can make. TOKENS says
        // what each KNOWN name should do; this says there is nothing ELSE. Every physical
        // name in the fixture is `zz_phys_`-prefixed, so any such token appearing outside a
        // names artifact is a physical name that escaped, whether or not anyone thought to
        // list it. Equality in BOTH directions — a new escape fails, and so does a declared
        // ESCAPE or KNOWN_LITERAL that has quietly been fixed.
        //
        // For Java the expected set is EMPTY, and that is the finding: this port's generated
        // code contains no physical database name anywhere. Not a gap to close — the physical
        // layer is the adopter's repository implementation, and <Entity>Names exists to be
        // referenced BY it. Widening the fixture to every shape the other ports had escapes
        // on did not change that answer; if it ever does, the failure here names the file.
        Pattern token = Pattern.compile("zz_phys_\\w+");
        Set<String> escaped = new TreeSet<>();
        for (Map.Entry<String, String> file : generate().entrySet()) {
            if (isNamesArtifact(file.getKey())) continue;
            Matcher m = token.matcher(file.getValue());
            while (m.find()) escaped.add(m.group());
        }
        Set<String> declared = TOKENS.stream()
            .filter(t -> t.reach() == Reach.ESCAPE || t.reach() == Reach.KNOWN_LITERAL)
            .map(Token::literal)
            .collect(Collectors.toCollection(TreeSet::new));
        assertEquals(declared, escaped);
    }

    @Test
    public void proves_every_escape_is_a_defect_and_not_a_structural_impossibility() throws Exception {
        // The row type lets an author write ESCAPE with a shouldUse naming a constant that
        // does not exist — which would read as "we know about it" while being unfixable, the
        // most comfortable possible state for a defect to sit in. So: for every escape, the
        // constant it should have used must be REACHABLE — its owning names artifact emitted,
        // by this same run, carrying the literal. That turns each row into a claim that can be
        // acted on today, and it is what separates these rows from the KNOWN_LITERAL ones.
        String names = namesBody(generate());
        Set<String> unreachable = TOKENS.stream()
            .filter(t -> t.reach() == Reach.ESCAPE)
            .filter(t -> !names.contains(t.literal()))
            .map(t -> t.literal() + " is marked an escape but " + t.shouldUse() + " is in no names artifact")
            .collect(Collectors.toCollection(TreeSet::new));
        assertEquals(String.join("\n", unreachable), Set.of(), unreachable);
    }

    @Test
    public void pins_each_dropped_name_as_carried_but_unread_so_wiring_it_up_fails_this_row() throws Exception {
        // A DROPPED row asserts BOTH halves of its own claim: the artifact carries the name
        // (so a consumer could read it) and no generated file references the constant (so
        // none does). Asserting the second half is the point — it is a pin on a DEFECT, and
        // the day a generator starts honouring the name this row fails and demands promotion
        // to CONSTANT, rather than the fix landing with nothing to notice it. Empty on this
        // port today, for the reason on the Reach javadoc; the test is what makes that a
        // checked statement rather than an assumed one.
        Map<String, String> tree = generate();
        String names = namesBody(tree);
        String body = consumerBody(tree);
        Set<String> wrong = new TreeSet<>();
        for (Token t : TOKENS) {
            if (t.reach() != Reach.DROPPED) continue;
            if (!names.contains(t.literal())) {
                wrong.add(t.literal() + " is marked dropped but no names artifact carries it");
            }
            if (body.contains(t.shouldUse())) {
                wrong.add(t.shouldUse() + " IS referenced now — promote \"" + t.literal() + "\" to CONSTANT");
            }
        }
        assertEquals(String.join("\n", wrong), Set.of(), wrong);
    }

    @Test
    public void names_with_no_slot_in_the_artifact_are_absent_from_it() throws Exception {
        // The pin on NO_SLOT: each of those names is declared in the model and carried by no
        // names artifact. (That it is also spelled by no other file is the exhaustive test's
        // job.) The day the artifact grows a slot for one — an index name, a replica view —
        // this fails and says "give it a TOKENS row", so a name cannot start being carried
        // with nothing checking whether anything reads it.
        String names = namesBody(generate());
        Set<String> carried = NO_SLOT.keySet().stream()
            .filter(names::contains)
            .map(lit -> lit + " has a slot now — give it a TOKENS row (" + NO_SLOT.get(lit) + ")")
            .collect(Collectors.toCollection(TreeSet::new));
        assertEquals(String.join("\n", carried), Set.of(), carried);
    }
}
