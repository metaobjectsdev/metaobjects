package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * FW-8 follow-up — a subtype SHADOWS a base-declared M:N relation name with a
 * differently-TPH-ness target. Mirrors the Python reference fixture
 * ({@code test_router_generator_tph_m2m_shadowed.py}).
 *
 * <p>{@code Auth} (base, {@code @discriminator: type}) declares {@code helpers ->
 * Tag} (Tag is NOT TPH). {@code BridgeAuth} (subtype) SHADOWS {@code helpers} onto
 * {@code PriorityTicket} — a concrete TPH subtype of the UNRELATED {@code Ticket}
 * hierarchy. {@code CopayAuth} does not shadow — it inherits the base's Tag-target
 * relationship unmodified.</p>
 *
 * <p>Because Java disambiguates every (relation name, source scope) pair into its
 * OWN interface method ({@code findHelpers} / {@code findHelpersForBridge} /
 * {@code findHelpersForCopay}), each finder's {@code targetSubtype} threading is
 * decided from ITS OWN resolved {@link SpringM2mSupport.M2mNav} — independently
 * correct by construction, with no shared seam across mounts to desynchronize (the
 * arity-mismatch hazard Python's single shared {@code Protocol} seam has to guard
 * against with a name-wide {@code str | None} decision does not arise in Java: a
 * real disagreement here would be a javac compile error, not a runtime 500). This
 * test proves the three finders for the SAME relation name land on three
 * DIFFERENT, individually-correct decisions.</p>
 */
public class SpringTphM2mShadowedTargetCodegenTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::auth", "children": [
            { "object.entity": { "name": "Tag", "children": [
                { "source.rdb":   { "@table": "tags" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
                { "source.rdb":   { "@table": "auths" } },
                { "field.long":   { "name": "id" } },
                { "field.enum":   { "name": "type", "@values": ["Bridge", "Copay"] } },
                { "field.string": { "name": "reference", "@required": true, "@maxLength": 80 } },
                { "relationship.association": { "name": "helpers", "@cardinality": "many",
                    "@objectRef": "Tag", "@through": "AuthHelper" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
                { "field.int": { "name": "quantity", "@required": true } },
                { "relationship.association": { "name": "helpers", "@cardinality": "many",
                    "@objectRef": "PriorityTicket", "@through": "BridgeHelper" } }
            ] } },
            { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
                { "field.decimal": { "name": "copayAmount", "@precision": 10, "@scale": 2 } }
            ] } },
            { "object.entity": { "name": "AuthHelper", "children": [
                { "source.rdb":         { "@table": "auth_helpers" } },
                { "field.long":         { "name": "authId",   "@required": true } },
                { "field.long":         { "name": "helperId", "@required": true } },
                { "identity.primary":   { "@fields": ["authId", "helperId"] } },
                { "identity.reference": { "name": "fkAuth",   "@fields": "authId",   "@references": "Auth" } },
                { "identity.reference": { "name": "fkHelper", "@fields": "helperId", "@references": "Tag" } }
            ] } },
            { "object.entity": { "name": "BridgeHelper", "children": [
                { "source.rdb":         { "@table": "bridge_helpers" } },
                { "field.long":         { "name": "bridgeAuthId", "@required": true } },
                { "field.long":         { "name": "ticketId",     "@required": true } },
                { "identity.primary":   { "@fields": ["bridgeAuthId", "ticketId"] } },
                { "identity.reference": { "name": "fkBridgeAuth", "@fields": "bridgeAuthId", "@references": "BridgeAuth" } },
                { "identity.reference": { "name": "fkTicket",     "@fields": "ticketId",     "@references": "PriorityTicket" } }
            ] } },
            { "object.entity": { "name": "Ticket", "@discriminator": "kind", "children": [
                { "source.rdb":   { "@table": "tickets" } },
                { "field.long":   { "name": "id" } },
                { "field.enum":   { "name": "kind", "@values": ["Priority", "Standard"] } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "PriorityTicket", "extends": "Ticket", "@discriminatorValue": "Priority", "children": [
                { "field.string": { "name": "escalation", "@maxLength": 40 } }
            ] } }
          ] }
        }
        """;

    private MetaDataLoader loadFixture() throws Exception {
        Path workspace = tempFolder.newFolder().toPath();
        return SpringTestFixtures.loadFixture(workspace, "tph-m2m-shadowed-target", FIXTURE);
    }

    private String generate(Object generator, MetaDataLoader loader, String relPath) throws Exception {
        Path outDir = tempFolder.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).setArgs(args);
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).execute(loader);
        Path f = outDir.resolve(relPath);
        assertTrue("expected generated file " + f, Files.exists(f));
        return Files.readString(f);
    }

    @Test
    public void baseWholeTableFinderStaysUnwidenedForItsOwnNonTphTarget() throws Exception {
        String src = generate(new SpringRepositoryGenerator(), loadFixture(), "acme/auth/AuthRepository.java");
        assertTrue("expected unwidened findHelpers; saw:\n" + src,
            src.contains("List<TagDto> findHelpers(Long sourceId);"));
        assertFalse(src.contains("findHelpers(Long sourceId, String targetSubtype)"));
    }

    @Test
    public void shadowingSubtypeFinderIsWidenedForItsOwnTphTarget() throws Exception {
        String src = generate(new SpringRepositoryGenerator(), loadFixture(), "acme/auth/AuthRepository.java");
        assertTrue("expected findHelpersForBridge(Long, String); saw:\n" + src,
            src.contains("List<PriorityTicketDto> findHelpersForBridge(Long sourceId, String targetSubtype);"));
    }

    @Test
    public void nonShadowingSubtypeFinderInheritsTheUnwidenedNonTphTarget() throws Exception {
        String src = generate(new SpringRepositoryGenerator(), loadFixture(), "acme/auth/AuthRepository.java");
        assertTrue("expected unwidened findHelpersForCopay (inherits Tag, non-TPH); saw:\n" + src,
            src.contains("List<TagDto> findHelpersForCopay(Long sourceId);"));
        assertFalse(src.contains("findHelpersForCopay(Long sourceId, String targetSubtype)"));
    }

    @Test
    public void everyMountOfTheShadowedNamePassesItsOwnCorrectCallSiteArgs() throws Exception {
        String src = generate(new SpringControllerGenerator(), loadFixture(), "acme/auth/AuthController.java");
        assertTrue("base mount: repository.findHelpers(id); saw:\n" + src,
            src.contains("repository.findHelpers(id));"));
        assertTrue("shadowing Bridge mount: repository.findHelpersForBridge(id, \"Priority\"); saw:\n" + src,
            src.contains("repository.findHelpersForBridge(id, \"Priority\")"));
        assertTrue("non-shadowing Copay mount: repository.findHelpersForCopay(id); saw:\n" + src,
            src.contains("repository.findHelpersForCopay(id));"));
        assertFalse("Bridge mount must not stay unwidened; saw:\n" + src,
            src.contains("repository.findHelpersForBridge(id));"));
    }
}
