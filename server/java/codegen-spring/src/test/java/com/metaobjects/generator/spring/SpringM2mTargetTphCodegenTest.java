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
 * FW-8 follow-up — M:N traversal whose TARGET is a TPH subtype, isolated from any
 * source-side TPH concern. Mirrors the Python reference fixture
 * ({@code test_router_generator_m2m_target_tph.py}): {@code Sponsor} (a plain,
 * non-TPH entity) declares a hetero M:N {@code bridgeAuths -> BridgeAuth}, where
 * {@code BridgeAuth} is a CONCRETE TPH subtype of {@code Auth}
 * ({@code @discriminatorValue: "Bridge"}). {@code BridgeAuth}'s rows physically
 * live in the shared {@code auths} table alongside {@code CopayAuth} rows, so an
 * unscoped junction traversal cannot itself tell a genuine Bridge row from a
 * same-table Copay row. Java's repository interface is consumer-implemented — it
 * cannot AND a discriminator into a join it does not write — so the fix widens the
 * finder seam with a build-time-literal {@code targetSubtype} argument, exactly as
 * for the self-join case in {@link SpringTphM2mCodegenTest}, but here proving the
 * SOURCE entity need not itself be part of any TPH hierarchy for the target-side
 * gate to apply.
 */
public class SpringM2mTargetTphCodegenTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    public static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::sponsor", "children": [
            { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
                { "source.rdb":   { "@table": "auths" } },
                { "field.long":   { "name": "id" } },
                { "field.enum":   { "name": "type", "@values": ["Bridge", "Copay"] } },
                { "field.string": { "name": "reference", "@required": true, "@maxLength": 80 } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
                { "field.int": { "name": "quantity", "@required": true } }
            ] } },
            { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
                { "field.decimal": { "name": "copayAmount", "@precision": 10, "@scale": 2 } }
            ] } },
            { "object.entity": { "name": "Sponsor", "children": [
                { "source.rdb":   { "@table": "sponsors" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
                { "relationship.association": { "name": "bridgeAuths", "@cardinality": "many",
                    "@objectRef": "BridgeAuth", "@through": "SponsorAuth" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "SponsorAuth", "children": [
                { "source.rdb":         { "@table": "sponsor_auths" } },
                { "field.long":         { "name": "sponsorId", "@required": true } },
                { "field.long":         { "name": "authId",    "@required": true } },
                { "identity.primary":   { "@fields": ["sponsorId", "authId"] } },
                { "identity.reference": { "name": "fkSponsor", "@fields": "sponsorId", "@references": "Sponsor" } },
                { "identity.reference": { "name": "fkAuth",    "@fields": "authId",    "@references": "BridgeAuth" } }
            ] } }
          ] }
        }
        """;

    private MetaDataLoader loadFixture() throws Exception {
        Path workspace = tempFolder.newFolder().toPath();
        return SpringTestFixtures.loadFixture(workspace, "m2m-target-tph", FIXTURE);
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
    public void repositoryFinderGainsTargetSubtypeParamForAVanillaSourceEntity() throws Exception {
        String src = generate(new SpringRepositoryGenerator(), loadFixture(), "acme/sponsor/SponsorRepository.java");
        assertTrue("expected findBridgeAuths(Long, String); saw:\n" + src,
            src.contains("List<BridgeAuthDto> findBridgeAuths(Long sourceId, String targetSubtype);"));
        assertFalse("the bare 1-arg form must not remain; saw:\n" + src,
            src.contains("List<BridgeAuthDto> findBridgeAuths(Long sourceId);"));
    }

    @Test
    public void controllerCallSitePassesTheResolvedDiscriminatorLiteral() throws Exception {
        String src = generate(new SpringControllerGenerator(), loadFixture(), "acme/sponsor/SponsorController.java");
        assertTrue("expected repository.findBridgeAuths(id, \"Bridge\"); saw:\n" + src,
            src.contains("repository.findBridgeAuths(id, \"Bridge\")"));
        assertFalse("the unwidened 1-arg call must not remain; saw:\n" + src,
            src.contains("repository.findBridgeAuths(id));"));
    }
}
