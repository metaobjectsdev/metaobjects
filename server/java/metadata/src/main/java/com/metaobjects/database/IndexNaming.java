package com.metaobjects.database;

import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;

/**
 * THE database-index name resolver for the JVM ports — the twin of {@link ColumnNaming},
 * and for the same reason.
 *
 * <p>An {@code identity.secondary} and an {@code index.lookup} carry no {@code @column}-style
 * physical spelling: the database name IS the metamodel name. That reads like there is
 * nothing to resolve, which is exactly why the answer ended up written independently at
 * every site that needed it — the Kotlin Exposed emitter's {@code init { uniqueIndex(…) }}
 * block, and each port's names artifact. {@code fdb4118f1} is what that coincidence looks
 * like when it lapses: codegen declared {@code idx_<table>_<col>} while the index in the
 * database was the identity's name. Nothing compared them; they were fixed to agree, not
 * made to share an answer.</p>
 *
 * <p>Its worth is not its body. It is that a caller cannot answer this question with
 * anything BUT this function, so the constant a {@code <Entity>Names} artifact declares and
 * the name the Exposed binding emits are one string by construction. TypeScript's
 * {@code resolveIndexName} ({@code metadata/src/naming.ts}) is the same door for that
 * port.</p>
 *
 * <h2>What the two rules are actually worth on the JVM — measured, not assumed</h2>
 *
 * <p>Both rules below were ported from TypeScript, whose commit message justified the strip
 * with a claim about THIS port: <em>"the JVM loader spells a nested index name
 * {@code acme::demo::by_name} where TypeScript does not"</em>. Measured against the loader,
 * that is <b>false</b>. {@code BaseMetaDataParser} qualifies a ROOT-level node's name with
 * the file's {@code package} and nothing else, so an {@code identity.secondary} or
 * {@code index.lookup} declared inside {@code acme::demo::Widget} is named {@code by_name}
 * flat — {@link MetaData#getShortName()} returns the name unchanged. It is still true of an
 * unnamed {@code view} child, whose FQN the loader does synthesise, which is the likeliest
 * source of the belief. The Kotlin Exposed emitter carried a local {@code shortName ?: name}
 * under a comment describing the strip it was performing; it was compensating for nothing.</p>
 *
 * <p>The strip stays anyway, and the reason is worth stating rather than leaving as inertia:
 * one door that answers "what is this index called in the database" is the point, and the
 * answer must not depend on whether the caller remembered to unqualify. It is a no-op on
 * every name the loader produces today, which is what a rule holding without a per-port
 * branch looks like.</p>
 *
 * <p>The EMPTY-name refusal is likewise not the same gap it is in TypeScript, and the
 * difference is a measurement rather than a translation:</p>
 *
 * <ul>
 *   <li>An {@code identity.secondary} with an empty name is refused by the LOADER —
 *       {@code ERR_IDENTITY_NAME_REQUIRED}, a hard failure of {@code loader.init()}, because
 *       identity nodes carry an FR-024 name check so a dotted {@code extends} ref can address
 *       them.</li>
 *   <li>An {@code index.lookup} carries no such check, but it does not reach an emitter empty
 *       either: {@code index} is not an auto-naming type, so the parser substitutes
 *       {@code name = subType} and the node arrives called {@code "lookup"}. TypeScript lets
 *       the empty string through to the emitter and produces {@code index("")}; the JVM
 *       produces {@code index("lookup")} — a plausible-looking name the model never
 *       declared, which is a different (and smaller) defect, and one that belongs to the
 *       parser rather than here.</li>
 * </ul>
 *
 * <p>So on the JVM this throw is a FAIL-CLOSED guard rather than a reachable authoring bug:
 * it fires for a node built programmatically, including the one shape
 * {@code MetaData.validateName} admits with an empty short name — a name like {@code "pkg::"},
 * whose {@code split("::")} drops the trailing empty segment and so passes the identifier
 * check while {@link MetaData#getShortName()} returns {@code ""}. A resolver that returned
 * that would emit SQL no engine accepts from a model that passed every gate.</p>
 */
public final class IndexNaming {

    private IndexNaming() {}

    /**
     * The database name of an {@code identity.secondary} or {@code index.lookup} node.
     *
     * @param node the identity/index node
     * @return its database name — the metamodel name, unqualified
     * @throws MetaDataException when the node resolves no name at all
     */
    public static String resolve(MetaData node) {
        if (node == null) {
            throw new MetaDataException(
                "cannot resolve an index name from a null node");
        }
        // getShortName() is the loader's own package strip. See the class doc for why this
        // is a no-op on every name the JVM parser produces, and why it is here regardless.
        // Deliberately NOT falling back to getName() when the short form is empty: the one
        // shape that produces an empty short name is a name like "pkg::", and returning THAT
        // would emit a package qualifier into DDL — a worse answer than refusing.
        String shortName = node.getShortName();
        if (shortName == null || shortName.isEmpty()) {
            throw new MetaDataException(
                node.getType() + "." + node.getSubType() + " declares an empty name; an "
                    + "index's database name IS its metamodel name, so there is nothing to "
                    + "emit. Give it a name.");
        }
        return shortName;
    }
}
