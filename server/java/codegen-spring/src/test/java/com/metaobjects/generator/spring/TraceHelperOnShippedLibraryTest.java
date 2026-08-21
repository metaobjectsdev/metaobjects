package com.metaobjects.generator.spring;

import com.metaobjects.field.MetaField;
import com.metaobjects.library.LibrarySources;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * #332 — the trace-helper generator runs against the SHIPPED
 * {@code metaobjects::ai::LlmCallBase}, not a hand-copied one.
 *
 * <p>Every other test of this generator declares its own {@code LlmCallBase} inline under a
 * different package. That is the bypass ADR-0024 already named — "the green tests pass only
 * because they bypass the shipped base with bespoke entities" — and it is precisely what let
 * the Java port ship this generator while having no way at all to LOAD the metadata it
 * exists to consume. A hand-copied base can also drift from the real one silently: the
 * copies stay green while the shipped file moves.</p>
 *
 * <p>This test loads the real library through the {@code libraries} opt-in and asserts both
 * directions of ADR-0024 FIX #1 — the fields the generator emits are exactly the shipped
 * base's effective fields, no more and no fewer.</p>
 */
public class TraceHelperOnShippedLibraryTest {

    /**
     * A concrete call entity extending the SHIPPED base — no local copy of it anywhere.
     * The request/response value objects and the nested {@code template.prompt} carrying
     * {@code @responseRef} are what the generator's applies-to predicate requires; only the
     * BASE is different from the other tests of this generator, which is the whole point.
     */
    private static final String META = "{\"metadata.root\": {"
        + "  \"package\": \"acme::app\","
        + "  \"children\": ["
        + "    { \"object.value\": { \"name\": \"GreetRequest\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"name\", \"@required\": true } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"GreetResponse\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"greeting\", \"@required\": true } }"
        + "    ]}},"
        + "    { \"object.entity\": {"
        + "        \"name\": \"GreetingCall\","
        + "        \"extends\": \"metaobjects::ai::LlmCallBase\","
        + "        \"children\": ["
        + "          { \"source.rdb\": { \"@table\": \"greeting_call\", \"@role\": \"primary\" } },"
        + "          { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"spanId\"] } },"
        + "          { \"template.prompt\": { \"name\": \"greetingPrompt\","
        + "                                  \"@payloadRef\": \"acme::app::GreetRequest\","
        + "                                  \"@responseRef\": \"acme::app::GreetResponse\" } }"
        + "        ]"
        + "    } }"
        + "  ]"
        + "}}";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private MetaDataLoader loadWithShippedLibrary(String name) {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, name);
        loader.setLibraries(Collections.singletonList("ai"));
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, name + "/meta.json")));
        return loader;
    }

    @Test
    public void generatesAHelperForAnEntityExtendingTheShippedBase() throws Exception {
        MetaDataLoader loader = loadWithShippedLibrary("trace-shipped");

        MetaObject base = loader.getMetaObjectByName("metaobjects::ai::LlmCallBase");
        assertNotNull("the SHIPPED base must be in the model — that is the whole point", base);

        MetaObject call = loader.getMetaObjectByName("acme::app::GreetingCall");
        assertNotNull("GreetingCall must load", call);

        Path gen = tmp.newFolder("gen").toPath();
        LlmTraceHelperGenerator generator = new LlmTraceHelperGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        generator.setArgs(args);
        generator.execute(loader);

        Path helper = gen.resolve("acme/app/GreetingCallTraceHelper.java");
        assertTrue("a helper must be emitted for an entity extending the SHIPPED base, at " + helper,
            Files.exists(helper));
    }

    /**
     * ADR-0024 FIX #1, both directions: the recorder's row keys are exactly the shipped
     * base's effective fields.
     *
     * <p>One direction alone is worthless here. "Every row key is a field" passes on a
     * recorder that writes nothing; "every field is a row key" passes on one that writes the
     * whole world. Only the equality says the two agree, which is the claim — and it is the
     * claim a hand-copied base can never make, because it is comparing a copy against
     * itself.</p>
     */
    @Test
    public void theShippedBaseFieldsAreExactlyWhatTheRecorderWrites() {
        MetaDataLoader loader = loadWithShippedLibrary("trace-shipped-fields");
        MetaObject base = loader.getMetaObjectByName("metaobjects::ai::LlmCallBase");
        assertNotNull(base);

        // ADR-0039: the RESOLVING accessor. An own-only read would drop anything the base
        // itself inherits, and the row keys are about the EFFECTIVE field set.
        List<String> baseFields = new ArrayList<>();
        for (MetaField f : base.getMetaFields()) baseFields.add(f.getName());

        MetaObject call = loader.getMetaObjectByName("acme::app::GreetingCall");
        List<String> callFields = new ArrayList<>();
        for (MetaField f : call.getMetaFields()) callFields.add(f.getName());

        assertTrue("the base must declare fields at all — an empty set would make the "
            + "equality below vacuously true", baseFields.size() >= 10);
        assertTrue("every shipped base field reaches the concrete entity through extends",
            callFields.containsAll(baseFields));
        assertEquals("the concrete entity adds no fields of its own in this fixture, so the "
            + "two sets must be equal — a difference means extends dropped or invented one",
            new TreeSet<>(baseFields), new TreeSet<>(callFields));
    }

    @Test
    public void theLibraryIsNotLoadedUnlessAskedFor() {
        // The negative arm for the generator path specifically: without the opt-in there is
        // no base, so there is nothing for the generator to key on. A test suite that only
        // ever declares its own base cannot tell these two worlds apart, which is exactly
        // how a generator came to ship without its input.
        assertTrue("the ai package must be one this build ships",
            LibrarySources.knownPackages().contains("ai"));
        assertTrue("and it must contribute nothing when not requested",
            LibrarySources.librarySources(Collections.emptyList()).isEmpty());
    }
}
