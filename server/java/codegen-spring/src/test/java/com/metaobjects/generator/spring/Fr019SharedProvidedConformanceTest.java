package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Cross-port FR-019 conformance (Java/Spring). Loads the shared fixture
 * {@code fixtures/codegen-conformance/shared-provided-enum/input/meta.json} and asserts the two
 * FR-019 behaviors (ADR-0026):
 * <ul>
 *   <li><b>Shared materialization</b> — a package-level abstract {@code field.enum}
 *       ({@code Priority}) extended by TWO entities is materialized ONCE as a standalone
 *       {@code Priority.java}; both DTOs reference it (no nested redeclaration).</li>
 *   <li><b>{@code @provided}</b> — a package-level abstract {@code field.enum} ({@code Currency},
 *       {@code @provided: true}) is NOT materialized; consuming DTOs reference it at the configured
 *       namespace ({@code <ns>.Currency}). A referenced provided enum with no configured namespace
 *       is a codegen-time error naming the enum.</li>
 * </ul>
 *
 * <p>Each port runs the SAME fixture (the oracle) and asserts its own idiomatic contract — no
 * byte-identical cross-language expectation.</p>
 */
public class Fr019SharedProvidedConformanceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private MetaDataLoader loadShared() throws IOException {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path fixture = repoRoot.resolve("fixtures/codegen-conformance/shared-provided-enum/input/meta.json");
        assertTrue("shared FR-019 fixture must exist at " + fixture, Files.exists(fixture));
        return SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "sharedProvidedEnum",
            Files.readString(fixture));
    }

    /** Run the DTO generator with the given optional {@code providedEnumNamespace} fallback. */
    private Path run(MetaDataLoader loader, String providedEnumNamespace) throws IOException {
        Path out = tmp.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        if (providedEnumNamespace != null) args.put("providedEnumNamespace", providedEnumNamespace);
        SpringDtoGenerator gen = new SpringDtoGenerator();
        gen.setArgs(args);
        gen.execute(loader);
        return out;
    }

    @Test
    public void sharedEnumIsMaterializedOnceAndReferencedByBothEntities() throws Exception {
        Path out = run(loadShared(), "com.acme.ext");

        // Materialized ONCE as a standalone top-level enum in the declaring package.
        Path sharedEnum = out.resolve("acme/shop/Priority.java");
        assertTrue("standalone Priority.java must be materialized; expected at " + sharedEnum,
            Files.exists(sharedEnum));
        assertTrue("standalone enum must declare members verbatim",
            Files.readString(sharedEnum).contains("public enum Priority { LOW, MEDIUM, HIGH }"));

        // Both entities reference it; neither redeclares the enum inline.
        for (String name : new String[] { "TicketDto.java", "OrderDto.java" }) {
            Path dto = out.resolve("acme/shop").resolve(name);
            assertTrue(name + " must be emitted", Files.exists(dto));
            String src = Files.readString(dto);
            assertTrue("priority component must be typed as the shared enum in " + name + "; saw:\n" + src,
                src.contains("Priority priority"));
            assertFalse("shared enum must NOT be nested in " + name + "; saw:\n" + src,
                src.contains("public enum Priority"));
        }
    }

    @Test
    public void multiHopEnumExtendsStillResolvesToTheSharedEnum() throws Exception {
        // Task.urgency extends Ticket.priority, which extends the shared abstract Priority.
        // Task ALSO carries phase/weight (own @values / @intValueMap, resp. — inline per-object
        // enums per rule (b)), so this asserts only that Priority specifically is referenced, not
        // redeclared — "no `public enum` at all" would wrongly fail on Task's legitimate inline
        // fields.
        Path out = run(loadShared(), "com.acme.ext");
        String task = Files.readString(out.resolve("acme/shop/TaskDto.java"));
        assertTrue("urgency must be typed as the shared enum; saw:\n" + task, task.contains("Priority urgency"));
        assertFalse("shared Priority must NOT be redeclared in TaskDto; saw:\n" + task,
            task.contains("public enum Priority"));
    }

    @Test
    public void providedEnumIsNotMaterializedAndReferencedAtTheConfiguredNamespace() throws Exception {
        Path out = run(loadShared(), "com.acme.ext");

        // Nothing emitted for the provided Currency type.
        assertFalse("provided Currency must NOT be materialized",
            Files.exists(out.resolve("acme/shop/Currency.java")));

        String ticket = Files.readString(out.resolve("acme/shop/TicketDto.java"));
        assertTrue("currency component must reference the configured external namespace; saw:\n" + ticket,
            ticket.contains("com.acme.ext.Currency currency"));
        assertFalse("provided Currency must NOT be nested in the DTO; saw:\n" + ticket,
            ticket.contains("public enum Currency"));
    }

    @Test
    public void providedEnumWithNoNamespaceConfigIsACodegenErrorNamingTheEnum() throws Exception {
        MetaDataLoader loader = loadShared();
        try {
            run(loader, null); // no providedEnumNamespace
            fail("expected a codegen-time error for the @provided enum with no namespace config");
        } catch (RuntimeException e) {
            assertTrue("error must name the provided enum Currency; was: " + e.getMessage(),
                e.getMessage() != null && e.getMessage().contains("Currency"));
        }
    }

    // =========================================================================
    // Decision table — one shared-enum rule for every object-hosted field.enum
    // =========================================================================

    /**
     * For EVERY object-hosted {@code field.enum} in the shared fixture (entities, the projection,
     * the value object), compute {@code {"shared": "<declaration FQN>"|null, "provided": bool}}
     * from the SAME function the Java generators call ({@link Fr019SharedEnum#sharedEnumForField})
     * and assert exact equality with {@code expected-enum-types.json}'s {@code fields} map in both
     * directions (no missing key, no extra key). Also asserts {@code materialized}.
     */
    @Test
    public void decisionTableMatchesSharedFixtureExpectation() throws Exception {
        MetaDataLoader loader = loadShared();
        Map<String, Map<String, Object>> actual = computeDecisionTable(loader);
        JsonNode expected = readExpectedEnumTypes();

        JsonNode expectedFields = expected.get("fields");
        Iterator<String> expectedKeys = expectedFields.fieldNames();
        int expectedCount = 0;
        while (expectedKeys.hasNext()) {
            String key = expectedKeys.next();
            expectedCount++;
            assertTrue("decision table missing key " + key + "; actual keys: " + actual.keySet(),
                actual.containsKey(key));
            JsonNode expectedEntry = expectedFields.get(key);
            Map<String, Object> actualEntry = actual.get(key);
            Object expectedShared = expectedEntry.get("shared").isNull()
                ? null : expectedEntry.get("shared").asText();
            assertEquals("mismatched 'shared' for " + key, expectedShared, actualEntry.get("shared"));
            assertEquals("mismatched 'provided' for " + key,
                expectedEntry.get("provided").asBoolean(), actualEntry.get("provided"));
        }
        assertEquals("decision table has extra keys beyond the fixture; actual: " + actual.keySet(),
            expectedCount, actual.size());

        List<String> expectedMaterialized = new ArrayList<>();
        for (JsonNode n : expected.get("materialized")) expectedMaterialized.add(n.asText());
        List<String> actualMaterialized = new ArrayList<>();
        for (Fr019SharedEnum.SharedEnum e : Fr019SharedEnum.materializedSharedEnums(loader)) {
            actualMaterialized.add(e.name());
        }
        assertEquals("materialized shared enums must match the fixture", expectedMaterialized, actualMaterialized);
    }

    /** {@code <package>::<Object>.<field>} -> {@code {"shared": <declaration FQN>|null, "provided": bool}},
     *  computed via {@link Fr019SharedEnum#sharedEnumForField} for every object-hosted
     *  {@code field.enum} on every concrete entity/projection/value object — no condition on the
     *  hosting object's subtype. */
    private static Map<String, Map<String, Object>> computeDecisionTable(MetaDataLoader loader) {
        Map<String, Map<String, Object>> out = new LinkedHashMap<>();
        for (MetaObject owner : loader.getMetaObjects()) {
            String subType = owner.getSubType();
            if (!MetaObject.SUBTYPE_ENTITY.equals(subType)
                && !MetaObject.SUBTYPE_PROJECTION.equals(subType)
                && !MetaObject.SUBTYPE_VALUE.equals(subType)) continue;
            for (MetaField<?> field : owner.getMetaFields()) {
                if (!(field instanceof EnumField)) continue;
                String key = owner.getName() + "." + field.getName();
                Fr019SharedEnum.SharedEnum shared = Fr019SharedEnum.sharedEnumForField(field);
                Map<String, Object> entry = new LinkedHashMap<>();
                if (shared == null) {
                    entry.put("shared", null);
                    entry.put("provided", false);
                } else {
                    String fqn = shared.metaPackage().isEmpty()
                        ? shared.name() : shared.metaPackage() + "::" + shared.name();
                    entry.put("shared", fqn);
                    entry.put("provided", shared.provided());
                }
                out.put(key, entry);
            }
        }
        return out;
    }

    private JsonNode readExpectedEnumTypes() throws IOException {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path path = repoRoot.resolve("fixtures/codegen-conformance/shared-provided-enum/expected-enum-types.json");
        assertTrue("expected-enum-types.json must exist at " + path, Files.exists(path));
        return new ObjectMapper().readTree(Files.readString(path));
    }

    // =========================================================================
    // Generated-output assertions — the multi-hop / provided / negative cases
    // =========================================================================

    @Test
    public void multiHopProjectionAndValueObjectFieldsReferenceTheSharedTypeAndItEmitsOnce() throws Exception {
        MetaDataLoader loader = loadShared();
        Path dtoOut = run(loader, "com.acme.ext");

        // Priority is materialized exactly once, regardless of how many objects/hops reach it.
        try (java.util.stream.Stream<Path> walk = Files.walk(dtoOut)) {
            long priorityFiles = walk.filter(p -> p.getFileName().toString().equals("Priority.java")).count();
            assertEquals("Priority.java must be emitted exactly once", 1, priorityFiles);
        }

        // Task.importance (Ticket.severity -> Priority, two hops) and Subtask.rank
        // (Task.importance -> Ticket.severity -> Priority, three hops).
        String taskDto = Files.readString(dtoOut.resolve("acme/shop/TaskDto.java"));
        assertTrue("Task.importance must be typed as the shared enum; saw:\n" + taskDto,
            taskDto.contains("Priority importance"));
        String subtaskDto = Files.readString(dtoOut.resolve("acme/shop/SubtaskDto.java"));
        assertTrue("Subtask.rank must be typed as the shared enum; saw:\n" + subtaskDto,
            subtaskDto.contains("Priority rank"));
        assertFalse("shared Priority must not be redeclared in SubtaskDto; saw:\n" + subtaskDto,
            subtaskDto.contains("public enum Priority"));

        // TicketSummary (a view-backed projection) reaches the shared Priority too.
        String ticketSummaryDto = Files.readString(dtoOut.resolve("acme/shop/TicketSummaryDto.java"));
        assertTrue("TicketSummary.level must be typed as the shared enum; saw:\n" + ticketSummaryDto,
            ticketSummaryDto.contains("Priority level"));
        assertFalse("shared Priority must not be redeclared in TicketSummaryDto; saw:\n" + ticketSummaryDto,
            ticketSummaryDto.contains("public enum Priority"));

        // TicketBadge (an object.value) reaches the shared Priority too — via SpringValueObjectGenerator.
        Path voOut = tmp.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", voOut.toString());
        args.put("providedEnumNamespace", "com.acme.ext");
        SpringValueObjectGenerator voGen = new SpringValueObjectGenerator();
        voGen.setArgs(args);
        voGen.execute(loader);
        String ticketBadge = Files.readString(voOut.resolve("acme/shop/TicketBadge.java"));
        assertTrue("TicketBadge.badge must be typed as the shared enum; saw:\n" + ticketBadge,
            ticketBadge.contains("Priority badge"));
        assertFalse("shared Priority must not be redeclared in TicketBadge; saw:\n" + ticketBadge,
            ticketBadge.contains("public enum Priority"));
    }

    @Test
    public void refundFieldsResolveToDistinctSharedDeclarationsOnTheSameObject() throws Exception {
        // Refund.ticketTier (via Ticket.tier) -> Priority; Refund.invoiceTier (via Invoice.tier)
        // -> Money — two fields on ONE object whose immediate supers are same-named fields
        // ("tier") of DIFFERENT objects, resolving to DIFFERENT shared declarations.
        MetaDataLoader loader = loadShared();
        Path out = run(loader, "com.acme.ext");
        String refundDto = Files.readString(out.resolve("acme/shop/RefundDto.java"));

        assertTrue("Refund.ticketTier must be typed Priority; saw:\n" + refundDto,
            refundDto.contains("Priority ticketTier"));
        assertTrue("Refund.invoiceTier must be typed Money; saw:\n" + refundDto,
            refundDto.contains("Money invoiceTier"));
        // Refund.unit -> Invoice.money -> the materialized Money.
        assertTrue("Refund.unit must be typed as the materialized Money; saw:\n" + refundDto,
            refundDto.contains("Money unit"));
        // Refund.tender -> Ticket.currency -> the @provided Currency (never materialized).
        assertTrue("Refund.tender must reference the configured external namespace; saw:\n" + refundDto,
            refundDto.contains("com.acme.ext.Currency tender"));
        assertFalse("provided Currency must never be nested in RefundDto; saw:\n" + refundDto,
            refundDto.contains("public enum Currency"));

        // Negative: Refund.orderStatus -> Order.status, which owns its own @values (inline).
        assertFalse("Refund.orderStatus must NOT be typed as a shared enum; saw:\n" + refundDto,
            refundDto.contains("Priority orderStatus") || refundDto.contains("Money orderStatus"));
    }

    @Test
    public void ownValuesOrIntValueMapStopsTheWalkAndKeepsAnInlinePerObjectEnum() throws Exception {
        // Task.phase (own @values) and Task.weight (own @intValueMap) each extend a field whose
        // OWN chain reaches the shared Priority — but their own redeclaration stops the walk
        // before it gets there, so they stay inline. Same for the Subtask fields that extend them.
        MetaDataLoader loader = loadShared();
        Path out = run(loader, "com.acme.ext");

        // Their top-most super is the shared Priority itself, whose name a nested enum would
        // shadow inside the DTO, so each is named <Owner><Field> and carries its OWN members.
        String taskDto = Files.readString(out.resolve("acme/shop/TaskDto.java"));
        assertTrue("Task.phase must be the nested TaskPhase with its own members; saw:\n" + taskDto,
            taskDto.contains("public enum TaskPhase { OPEN, DONE }") && taskDto.contains("TaskPhase phase"));
        assertTrue("Task.weight must be the nested int-backed TaskWeight; saw:\n" + taskDto,
            taskDto.contains("public enum TaskWeight {") && taskDto.contains("LOW(1)")
                && taskDto.contains("HIGH(3)") && taskDto.contains("TaskWeight weight"));
        // A shared-typed field in the SAME DTO still binds to the top-level shared Priority.
        assertTrue("Task.urgency must still be typed by the shared Priority; saw:\n" + taskDto,
            taskDto.contains("Priority urgency"));
        assertFalse("TaskDto must not nest an enum named for the shared declaration; saw:\n" + taskDto,
            taskDto.contains("public enum Priority"));

        String subtaskDto = Files.readString(out.resolve("acme/shop/SubtaskDto.java"));
        assertTrue("Subtask.phase must be the nested SubtaskPhase with the members it inherits; saw:\n" + subtaskDto,
            subtaskDto.contains("public enum SubtaskPhase { OPEN, DONE }") && subtaskDto.contains("SubtaskPhase phase"));
        assertTrue("Subtask.weight must be the nested int-backed SubtaskWeight; saw:\n" + subtaskDto,
            subtaskDto.contains("public enum SubtaskWeight {") && subtaskDto.contains("MEDIUM(2)")
                && subtaskDto.contains("SubtaskWeight weight"));
        assertTrue("Subtask.rank must still be typed by the shared Priority; saw:\n" + subtaskDto,
            subtaskDto.contains("Priority rank"));
        assertFalse("SubtaskDto must not nest an enum named for the shared declaration; saw:\n" + subtaskDto,
            subtaskDto.contains("public enum Priority"));

        // Refund.orderStatus extends Order.status, an inline enum with no shared declaration
        // anywhere on the chain: it keeps the name it always had, the top-most super's.
        String refundDto = Files.readString(out.resolve("acme/shop/RefundDto.java"));
        assertTrue("Refund.orderStatus must keep its nested Status enum; saw:\n" + refundDto,
            refundDto.contains("public enum Status { NEW, PAID }") && refundDto.contains("Status orderStatus"));
    }

    @Test
    public void valueObjectFieldOneHopFromASharedOrProvidedDeclarationReferencesItAndNestsNoEnum() throws Exception {
        // TicketLabel.grade extends the shared Priority and TicketLabel.denomination the
        // @provided Currency, each in ONE hop. The record references the top-level type and the
        // configured external type; it declares no enum of its own.
        Path voOut = tmp.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", voOut.toString());
        args.put("providedEnumNamespace", "com.acme.ext");
        SpringValueObjectGenerator voGen = new SpringValueObjectGenerator();
        voGen.setArgs(args);
        voGen.execute(loadShared());

        String label = Files.readString(voOut.resolve("acme/shop/TicketLabel.java"));
        assertTrue("TicketLabel.grade must be typed by the top-level shared Priority; saw:\n" + label,
            label.contains("Priority grade"));
        assertTrue("TicketLabel.denomination must reference the configured external Currency; saw:\n" + label,
            label.contains("com.acme.ext.Currency denomination"));
        assertFalse("TicketLabel must nest no enum; saw:\n" + label, label.contains("enum "));
        assertTrue("the shared Priority must be emitted by the value-object run itself",
            Files.readString(voOut.resolve("acme/shop/Priority.java"))
                .contains("public enum Priority { LOW, MEDIUM, HIGH }"));
        assertFalse("the @provided Currency must never be generated",
            Files.exists(voOut.resolve("acme/shop/Currency.java")));
    }

    @Test
    public void sharedEnumMaterializesWhenTheOnlyGeneratedConsumerIsAProjection() throws Exception {
        // No condition on the hosting object's subtype: a model whose ONLY object at all is a
        // view-backed projection whose enum field extends a shared root-level abstract
        // declaration still materializes that declaration — as narrow a "run" as there is.
        String fixtureJson = """
            {
              "metadata.root": { "package": "acme::only", "children": [
                { "field.enum": { "name": "Status", "abstract": true, "@values": ["DRAFT","PUBLISHED"] } },
                { "object.projection": { "name": "StatusView", "children": [
                    { "source.rdb": { "@kind": "view", "@view": "v_status" } },
                    { "field.enum": { "name": "status", "extends": "acme::only::Status" } }
                ] } }
              ] }
            }
            """;
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder().toPath(), "projectionOnly", fixtureJson);
        Path out = run(loader, "com.acme.ext");

        assertTrue("Status.java must be materialized when a projection is the only consumer",
            Files.exists(out.resolve("acme/only/Status.java")));
        String statusViewDto = Files.readString(out.resolve("acme/only/StatusViewDto.java"));
        assertTrue("StatusView.status must reference the shared Status; saw:\n" + statusViewDto,
            statusViewDto.contains("Status status"));
        assertFalse("shared Status must not be redeclared in StatusViewDto; saw:\n" + statusViewDto,
            statusViewDto.contains("public enum Status"));
    }
}
