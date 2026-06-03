/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.registry;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * SP-G Registry Conformance — the Java runner.
 *
 * <p>Composes a registry from the DEFINED metamodel provider set
 * ({@link RegistryManifest#composeMetamodelRegistry()} — core types + field /
 * attr / validator / relationship / identity + database extensions + source /
 * origin + common doc attrs + view / layout / template + core objects) and
 * asserts the emitted manifest is byte-identical to the single committed
 * canonical {@code fixtures/registry-conformance/expected-registry.json}.</p>
 *
 * <p>It composes from that defined set rather than the process-global
 * {@link MetaDataRegistry#getInstance()} singleton so the gate measures the same
 * metamodel vocabulary from EVERY module that runs it — notably
 * {@code codegen-kotlin}, whose test classpath also carries the {@code om} +
 * {@code codegen-base} SPI providers (which register an extra
 * {@code object.managed} subtype and ~22 codegen-tooling attrs the generators
 * self-register). Mirrors the TS reference's
 * {@code composeRegistry(coreProviders)}.</p>
 *
 * <p>This is a drift-finding gate: any mismatch is a real divergence between the
 * Java registry's logical vocabulary and the cross-port contract. Fix the Java
 * registration to match the canonical (TS is the reference) — do NOT loosen the
 * canonical to accommodate drift. The only escalation is if TS itself is wrong
 * versus the documented vocabulary.</p>
 *
 * <p><strong>LIVE (SP-G Unit 8).</strong> Units 4-7 reconciled the Java metamodel
 * registry to byte-match the canonical; Unit 8 re-enabled this gate (and the
 * Kotlin one), wired both into {@code .github/workflows/conformance.yml}, and
 * constrained the runner to the defined metamodel provider set (above). The
 * history of the reconciled divergences is retained below for context.</p>
 *
 * <p><strong>History — the reconciled divergences.</strong> Running this gate
 * surfaced a pervasive, structural divergence between Java's registry and the
 * cross-port logical vocabulary that TS, C#, and Python all agree on (the
 * canonical). It was NOT the targeted, attr-level drift this gate was scoped to
 * catch — it was a whole-vocabulary mismatch across every type family, since
 * reconciled unit-by-unit:</p>
 * <ul>
 *   <li>Java models the structural reserved keywords {@code abstract}
 *       ({@code @isAbstract}) and {@code isArray} ({@code @isArray}) as ordinary
 *       attrs, and registers {@code @description} per-type (it is a commonAttr in
 *       the contract) — none of which the other three ports register as per-type
 *       attrs.</li>
 *   <li>Java carried a parallel physical-DB attr vocabulary
 *       ({@code dbType}/{@code dbIndex}/{@code dbLength}/{@code dbNullable}/
 *       {@code dbForeignKey}/{@code dbPrecision}/{@code dbScale}/{@code dbUnique}/
 *       {@code dbSequenceName}/{@code dbIndexName}/{@code dbTablespace}/
 *       {@code previousName}) instead of the contract's
 *       {@code column}/{@code db.indexed}/{@code dbColumnType} plus the logical
 *       {@code maxLength}/{@code precision}/{@code scale}/{@code unique}.
 *       <strong>Reconciled in SP-G Unit 7:</strong> the logical-equivalent db* attrs
 *       were converged onto the cross-port names (consumers in {@code omdb} +
 *       {@code codegen-mustache} migrated; {@code dbType="jsonb"} owned-object storage
 *       now reads {@code field.object @storage="jsonb"}), and the DDL/migration-only
 *       remnants ({@code dbForeignKey}/{@code previousName}/{@code dbIndexName}/
 *       {@code dbSequenceName}/{@code dbTablespace}) were dropped as dead under
 *       ADR-0015 (OMDB is pure data-access).</li>
 *   <li>Java is missing the contract's logical field attrs
 *       {@code autoSet}/{@code filterable}/{@code sortable}/
 *       {@code sortableDefaultOrder}/{@code readOnly}/{@code storage} and carries
 *       Java-specific feature attrs the contract does not
 *       ({@code minLength}/{@code pattern}/{@code maxValue}/{@code minValue}/
 *       {@code format}/{@code dateFormat}/{@code maxDate}/{@code minDate}).
 *       The {@code validator.*} family has since been
 *       reconciled to the canonical (SP-G Unit 5): {@code @min}/{@code @max} are
 *       int-typed on {@code base}/{@code length}/{@code numeric}/{@code regex}/
 *       {@code array}, {@code regex} keeps {@code @pattern}, {@code required}
 *       carries none, and the legacy {@code msg}/{@code mask}/{@code maxSize}/
 *       {@code minSize} extras were dropped. The field-validation extras
 *       ({@code minLength}/{@code pattern}/{@code maxValue}/{@code minValue}/
 *       {@code format}/{@code dateFormat}/{@code maxDate}/{@code minDate}/
 *       {@code maxTime}/{@code minTime}) and the field {@code locale} were
 *       reconciled in SP-G Unit 6c — refactor-dropped from the field classes
 *       (validation is expressed via {@code validator.*} children, the cross-port
 *       form; the temporal-format / currency-locale attrs were vestigial). The
 *       physical {@code db*} set was reconciled in SP-G Unit 7 (above).</li>
 *   <li>{@code object.*} carried Java OO attrs
 *       ({@code extends}/{@code implements}/{@code object}/{@code objectAdapter}/
 *       {@code isInterface}/{@code value*}/{@code data*}). The structural keywords
 *       ({@code extends}/{@code implements}/{@code isInterface}) and the
 *       per-port type-binding facets ({@code object}/{@code objectAdapter} —
 *       ADR-0001/ADR-0005, kept registered but excluded from the manifest) were
 *       reconciled in SP-G Unit 6b/6b-finish; the {@code value*}/{@code data*}
 *       vestigial sets were refactor-dropped (Unit 6b).</li>
 *   <li>Subtype gaps/extras: Java lacks {@code field.byte}, {@code field.short},
 *       {@code attr.stringarray} and the 11 generic {@code view.*} subtypes
 *       (checkbox/date/dropdown/hidden/hotlink/month/number/password/radio/text/
 *       textarea/web), and carries an extra {@code metadata.base} (its
 *       inheritance anchor; the other ports register only {@code metadata.root}).</li>
 * </ul>
 * <p><strong>SP-G Unit 6a reconciled</strong> (registration-only structural items):
 * required-ness flips ({@code identity.primary/secondary/reference.fields},
 * {@code identity.reference.references}, {@code origin.aggregate.agg/of/via},
 * {@code origin.collection.via}, {@code origin.passthrough.from},
 * {@code template.output.payloadRef} now {@code required:true}); base→leaf placement
 * ({@code source.*}/{@code template.*}/{@code origin.*} shared attrs moved off the
 * abstract base onto the concrete subtypes so each base row is attr-free and the
 * concrete rows carry exactly the canonical per-subtype set, with the origin
 * cross-leak removed); and stray-attr drops ({@code defaultView} off every field,
 * {@code identity.secondary.generation}, {@code identity.reference.onDelete/onUpdate}).
 * The object-OO structural keywords + {@code object}/{@code objectAdapter} binding
 * facets + {@code value*}/{@code data*} (Unit 6b/6b-finish) and the field-validation
 * extras + field {@code locale} (Unit 6c) and the physical {@code db*} set (Unit 7)
 * have all been reconciled, so the residual is now EMPTY — the Java manifest
 * byte-matches the canonical.</p>
 * <p>Reconciling this at source means rewriting Java's metamodel attribute layer
 * to the cross-port vocabulary — a change that ripples through the loader's
 * validation, OMDB, {@code codegen-spring}, and {@code codegen-kotlin} (all of
 * which consume the current Java attrs) and is far beyond a detection-gate unit.
 * The canonical is NOT edited (TS/C#/Python agree it is correct). That
 * reconciliation has now landed (Units 4-7) and this gate is re-enabled (Unit 8).</p>
 */
public class RegistryManifestConformanceTest {

    @Test
    public void manifestMatchesCanonical() {
        // Compose from the DEFINED metamodel provider set (the same set the
        // metadata-module SPI declares), NOT the process-global singleton — so
        // every module that runs this gate (incl. codegen-kotlin, whose test
        // classpath also carries `om` + `codegen-base` SPI providers) measures
        // the identical cross-port metamodel vocabulary. Mirrors the TS
        // reference's composeRegistry(coreProviders). See RegistryManifest.
        MetaDataRegistry registry = RegistryManifest.composeMetamodelRegistry();

        String got = RegistryManifest.emit(registry);
        String want = readCanonical();

        // Newline-normalize both sides to '\n' so a CRLF checkout cannot mask a
        // real divergence (and vice-versa).
        String wantNorm = want.replace("\r\n", "\n");
        String gotNorm = got.replace("\r\n", "\n");

        // Best-effort debug artifact: on mismatch, write the emitted manifest to
        // target/ so the exact byte-divergence can be diffed against the canonical.
        if (!wantNorm.equals(gotNorm)) {
            try {
                Files.write(Paths.get("target/registry-got.json"),
                    gotNorm.getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignore) {
                // best-effort only
            }
        }

        assertEquals(
            "SP-G registry-conformance gate FAILED: the Java metamodel registry "
                + "diverges from the cross-port canonical "
                + "(fixtures/registry-conformance/expected-registry.json). Fix the Java "
                + "registration to match the cross-port contract, or escalate if TS is wrong.",
            wantNorm, gotNorm);
    }

    /** Locate + read {@code fixtures/registry-conformance/expected-registry.json}. */
    static String readCanonical() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/registry-conformance/expected-registry.json");
            if (Files.isRegularFile(candidate)) {
                try {
                    return new String(Files.readAllBytes(candidate), StandardCharsets.UTF_8);
                } catch (Exception e) {
                    throw new AssertionError("Failed to read canonical: " + candidate, e);
                }
            }
            dir = dir.getParent();
        }
        throw new AssertionError(
            "Could not locate fixtures/registry-conformance/expected-registry.json "
                + "by walking up from " + Paths.get("").toAbsolutePath());
    }
}
