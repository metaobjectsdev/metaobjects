/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.loader;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaDataNotFoundException;
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.parser.BaseMetaDataParser;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.loader.parser.yaml.ParserYaml;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import com.metaobjects.object.MetaObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.metaobjects.loader.uri.URIHelper;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * MetaDataLoader serves as the foundation for loading and managing metadata definitions.
 *
 * <p>As of H3a Task 4, {@code MetaDataLoader} is a <strong>plain class</strong> — it is no
 * longer a {@link MetaData} node. Instead it <em>produces</em> and owns a {@link MetaRoot}
 * (the real tree-root node), accessible via {@link #getRoot()}. All loaded objects/fields
 * attach as children of that root. The loader retains source consumption, parse
 * orchestration, deferred super-resolution, the validation passes, freeze, registry
 * integration, and error/warning collection — but no longer carries node identity
 * (no children/parent/attrs of its own).</p>
 *
 * <p>MetaDataLoader operates exactly like Java's ClassLoader - it loads metadata definitions
 * once at startup and keeps them permanently in memory for the application lifetime. This is
 * <strong>NOT</strong> a typical data access pattern but rather a metadata definition system
 * analogous to the Java reflection system.</p>
 *
 * <strong>Loading vs Runtime Phases</strong>:
 * <pre>{@code
 * // LOADING PHASE - Happens once at startup
 * MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true), "manual", "myLoader");
 * loader.setSourceURIs(Arrays.asList(URIHelper.toURI("model:file:/path/to/metadata.json")));
 * loader.init(); // Loads ALL metadata into permanent memory structures (including URI sources)
 *
 * // RUNTIME PHASE - All operations are READ-ONLY
 * MetaObject userMeta = loader.getMetaObjectByName("User");  // O(1) lookup
 * MetaField field = userMeta.getMetaField("email");          // Cached access
 * }</pre>
 *
 * @author Doug Mealing
 * @version 6.0.0
 * @since 1.0
 * @see MetaRoot
 */
public class MetaDataLoader implements LoaderConfigurable {

    private static final Logger log = LoggerFactory.getLogger(MetaDataLoader.class);

    // Concurrent loading protection
    private static final ConcurrentHashMap<String, CompletableFuture<MetaDataLoader>> activeLoaders = new ConcurrentHashMap<>();
    private static final long DEFAULT_LOADING_TIMEOUT_MS = 30000; // 30 seconds

    public final static String TYPE_LOADER = "loader";
    public final static String SUBTYPE_MANUAL = "manual";

    /** Package separator — re-exported for parser convenience (mirrors {@link MetaData#PKG_SEPARATOR}). */
    public final static String PKG_SEPARATOR = MetaData.PKG_SEPARATOR;

    // TODO:  Allow for custom configurations for overloaded MetaDataLoaders
    private final LoaderOptions loaderOptions;

    // Loader identity (the loader is no longer a MetaData node, so it keeps its
    // own type/subType/name fields).
    private final String subType;
    private final String name;

    // Process-unique instance discriminator. Used ONLY to scope the activeLoaders
    // concurrency-protection key to THIS instance (#233): two loaders sharing
    // class/subType/name (e.g. two reactor modules with the same <loader> name)
    // must NOT share one init() future — the future loads into whichever instance
    // won the race, leaving the other's tree empty. Not part of identity / equals /
    // hashCode / toString.
    private static final java.util.concurrent.atomic.AtomicLong INSTANCE_SEQ =
            new java.util.concurrent.atomic.AtomicLong();
    private final long instanceId = INSTANCE_SEQ.incrementAndGet();

    // The tree-root node this loader produces and owns.
    private final MetaRoot root;

    // ClassLoader used for resolving metadata-referenced Java classes.
    private ClassLoader metaDataClassLoader = null;

    // v6.0.0: Unified registry
    private MetaDataRegistry typeRegistry = null;
    private MetaDataLoaderRegistry loaderRegistry = null;

    // Enhanced thread-safe loading state management (sole lifecycle authority;
    // the legacy isInitialized/isRegistered/isDestroyed booleans were removed
    // in H3a Task 4).
    private final LoadingState loadingState = new LoadingState();

    // URI-based source list (H3a Task 5: lifted from SimpleLoader).
    // If set before init(), sources are loaded automatically during init().
    private List<URI> sourceURIs = null;

    // Validation-phase warnings accumulator.
    //
    // Mirrors the TS/C#/Python warning surfaces (a per-load list of human-readable
    // warning strings produced by {@link ValidationPhase}). Consumers — primarily
    // the conformance harness today — read this after {@link #load(List)} returns
    // (which is the call site that runs {@link ValidationPhase#run(MetaRoot)}).
    //
    // Cleared at the start of every {@link #load(List)} so a subsequent load on
    // the same loader does not accumulate prior-batch warnings. Errors continue
    // to be eager-thrown — warnings are non-fatal, errors are not.
    //
    // Package-private mutator ({@link #addWarning(String)}) keeps callers
    // restricted to the loader package (where {@link ValidationPhase} lives).
    private final List<String> warnings = new ArrayList<>();

    // Validation-phase errors accumulator.
    //
    // Mirrors {@link #warnings} but for ErrorCode-bearing validation errors that
    // a phase chose to RECORD rather than eager-throw. The Java loader continues
    // to be eager-throw on the first hard error in any phase, but phases may
    // opt to call {@link #addError(MetaDataException)} when they have collected
    // multiple extractable errors in a single pass — see the conformance contract
    // (spec/conformance-tests.md): the sorted set of error codes from a load
    // attempt MUST equal the expected set, so multi-error fixtures need every
    // collected error visible to the harness.
    //
    // Cleared at the start of every {@link #load(List)} so a subsequent load on
    // the same loader does not see stale errors. The conformance harness reads
    // this list AFTER catching the load's (final) thrown MetaDataException and
    // merges the two into a single per-fixture error set.
    private final List<MetaDataException> errors = new ArrayList<>();

    // FR5c — envelope-shaped warnings accumulator (cross-port parallel channel).
    //
    // Distinct from the {@link #warnings} legacy-string channel: envelope
    // warnings already carry their own {@code WARN_*} code + {@link
    // com.metaobjects.source.ErrorSource} provenance and are produced by
    // FR5c-onward sites (the canonical first emitter is the duplicate-
    // declaration site in {@code CanonicalJsonParser}). The conformance harness
    // today reads warnings as a flat string list via {@link #getWarnings()};
    // FR5c parser sites also push the {@link com.metaobjects.source.LoaderWarning#message()}
    // string into the legacy channel so the harness sees both forms without
    // needing a new contract.
    //
    // Cleared at the start of every {@link #load(List)} so a subsequent load on
    // the same loader does not see stale warnings. Mirrors the TS
    // {@code envelopeWarnings: LoaderWarning[]} channel on {@code ParseResult}.
    private final List<com.metaobjects.source.LoaderWarning> envelopeWarnings = new ArrayList<>();

    /**
     * Deferred-extends queue. The parser cannot always resolve a node's
     * {@code extends} ref at parse time (e.g. cross-file forward references).
     * It queues unresolved cases here; {@link #resolvePendingExtends()} runs
     * after all sources in a batch are parsed and either binds them or throws
     * {@code ERR_UNRESOLVED_SUPER}.
     */
    private final List<PendingExtends> pendingExtends = new ArrayList<>();

    /** One row in the deferred-extends queue. */
    public static final class PendingExtends {
        public final MetaData child;
        public final String typeName;
        public final String superName;
        public final String packageName;
        public final String filename;
        public PendingExtends(MetaData child, String typeName, String superName,
                              String packageName, String filename) {
            this.child = child;
            this.typeName = typeName;
            this.superName = superName;
            this.packageName = packageName;
            this.filename = filename;
        }
    }

    /** Queue an unresolved {@code extends} for post-load resolution. */
    public void addPendingExtends(PendingExtends pending) {
        if (pending != null) pendingExtends.add(pending);
    }

    /**
     * Resolve queued cross-file/forward {@code extends} refs. Mirrors the
     * TS/C# behaviour: defer the lookup until every source has populated the
     * tree, then bind. Anything still unresolved throws ERR_UNRESOLVED_SUPER.
     *
     * <p><b>TODO: cycle detection.</b> Single-pass resolve matches TS reference
     * behavior (parity, not regression), but a cycle (a → b → a) would land
     * silently and only surface at usage time. Add a one-pass cycle check at
     * queue drain when this becomes a real-world hazard.</p>
     */
    /**
     * Drain the deferred-extends queue. Public for harnesses that drive the
     * parse pipeline manually (e.g. the YAML conformance runner, which calls
     * desugar → buildTree → THIS → ValidationPhase to collect per-stage
     * diagnostics) — the normal {@link #load} path calls it automatically.
     * FR-024: validation passes (e.g. identity @fields-through-inheritance)
     * depend on extends being resolved first, so any manual pipeline MUST
     * drain before validating.
     */
    public void drainPendingExtends() {
        resolvePendingExtends();
    }

    private void resolvePendingExtends() {
        if (pendingExtends.isEmpty()) return;
        // #188 — deferred super-resolution must be ORDER-INDEPENDENT. The former
        // single pre-order pass resolved each queued node's `extends` in physical-
        // declaration (= load) order, so a dotted `extends: Owner.member` ref to an
        // INHERITED member (Owner gets `member` via its OWN `extends`) only
        // succeeded when Owner's own chain happened to be wired first — green under
        // one directory-scan order, ERR_UNRESOLVED_SUPER under another (Node vs Bun
        // readdir). Instead resolve ON DEMAND with memoization + cycle detection
        // (topological): before a dotted ref reads the owner's EFFECTIVE children,
        // resolve the owner node's whole chain first. The result is a pure function
        // of the source SET, independent of enumeration order. Mirrors the TS
        // reference (super-resolve.ts, #188).
        //
        // Identity-keyed maps/sets: MetaData nodes are compared by reference here
        // (a queued entry's `child` is the SAME tree-node instance that
        // resolveOwnerObject / getChildOfType returns), never by value-equality.
        java.util.IdentityHashMap<MetaData, PendingExtends> byChild =
            new java.util.IdentityHashMap<>();
        for (PendingExtends p : pendingExtends) {
            byChild.put(p.child, p);
        }
        java.util.Set<MetaData> inProgress =
            java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        java.util.Set<MetaData> resolved =
            java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        for (PendingExtends p : pendingExtends) {
            resolvePendingNode(p, byChild, inProgress, resolved);
        }
        pendingExtends.clear();
    }

    /**
     * Resolve ONE deferred {@code extends} entry, ON DEMAND and memoized (#188).
     *
     * <p>For a dotted child-targeting ref, the OWNER object's own {@code extends}
     * chain is resolved FIRST (recursively, memoized) so the owner's EFFECTIVE
     * children include inherited members before {@link #resolveChildTargetingRef}
     * reads them — regardless of the order the sources were enumerated. After the
     * node itself is wired, the resolved TARGET's own chain is resolved too, so a
     * later effective-children read on this node sees the full multi-level
     * inherited set (e.g. {@code Base extends AbstractRoot}). Memoization means no
     * node is resolved twice; the {@code inProgress} set breaks a genuine super
     * cycle (the node is left for its originating frame, which reports the failure
     * as {@code ERR_UNRESOLVED_SUPER}).</p>
     *
     * <p>The Tier-1 contract is unchanged: an unresolved ref throws
     * {@code ERR_UNRESOLVED_SUPER} and a type/subtype-mismatched dotted target
     * throws {@code ERR_EXTENDS_TARGET_MISMATCH}, both via the existing helpers.</p>
     */
    private void resolvePendingNode(PendingExtends p,
                                    java.util.IdentityHashMap<MetaData, PendingExtends> byChild,
                                    java.util.Set<MetaData> inProgress,
                                    java.util.Set<MetaData> resolved) {
        if (resolved.contains(p.child)) return;   // already wired (memoized)
        if (inProgress.contains(p.child)) return; // cycle — leave to the outer frame
        inProgress.add(p.child);

        MetaData superData;
        // FR-024 (ADR-0029): dotted child-targeting ref `<ownerRef>.<childName>` —
        // the final ::-segment containing '.' is unambiguous (names cannot contain
        // '.'). Resolve the OWNER object with the existing strategies, then select
        // the child among the owner's EFFECTIVE children (includeParentData) by
        // name + the REFERRER'S type (type-scoped: a field ref resolves fields,
        // an identity ref identities). Dotted refs never fall through to the bare
        // top-level lookup; the multi-dot form (X.y.z) is reserved → unresolved.
        // A resolved dotted target whose type/subtype differs from the referrer's
        // is ERR_EXTENDS_TARGET_MISMATCH (dotted-only — top-level extends behavior
        // is unchanged). Mirrors the TS reference (super-resolve.ts) and C#
        // SuperResolve.cs. The parser's getSuperMetaData never resolves dotted refs
        // (no top-level node has a dotted name), so every dotted ref arrives here
        // via the pending queue — single resolution site.
        if (isChildTargetingRef(p.superName)) {
            // #188: wire the owner's OWN chain first so its effective children
            // include inherited members before resolveChildTargetingRef reads them.
            MetaData owner = resolveOwnerObject(p);
            if (owner != null) {
                PendingExtends ownerPending = byChild.get(owner);
                if (ownerPending != null) {
                    resolvePendingNode(ownerPending, byChild, inProgress, resolved);
                }
            }
            superData = resolveChildTargetingRef(p, owner);
        } else {
            superData = resolveTopLevelSuper(p);
        }
        if (superData == null) {
            throwUnresolvedSuper(p);
        }

        p.child.setSuperData(superData);
        inProgress.remove(p.child);
        resolved.add(p.child);

        // #188: resolve the TARGET's own chain too (multi-level inheritance),
        // memoized — so a subsequent effective read on this node sees every
        // inherited member. No-op when the target had no deferred extends.
        PendingExtends targetPending = byChild.get(superData);
        if (targetPending != null) {
            resolvePendingNode(targetPending, byChild, inProgress, resolved);
        }
    }

    /**
     * Resolve a non-dotted top-level {@code extends} ref: try the package-prepended
     * name first, then the raw/FQN name. Returns {@code null} when neither resolves
     * (the caller throws {@code ERR_UNRESOLVED_SUPER}). Extracted verbatim from the
     * former inline {@link #resolvePendingExtends} loop body.
     */
    private MetaData resolveTopLevelSuper(PendingExtends p) {
        MetaData superData = null;
        try {
            String sn = p.superName;
            String pkg = p.packageName == null ? "" : p.packageName;
            if (sn.indexOf(PKG_SEPARATOR) < 0 && !pkg.isEmpty()) {
                superData = getChildOfType(p.typeName, pkg + PKG_SEPARATOR + sn);
            }
        } catch (com.metaobjects.MetaDataNotFoundException ignore) {
            // fall through to FQN lookup
        }
        if (superData == null) {
            try {
                superData = getChildOfType(p.typeName, p.superName);
            } catch (com.metaobjects.MetaDataNotFoundException ignore) {
                // still unresolved
            }
        }
        return superData;
    }

    /**
     * FR5d — emit format=resolved with referrer + target. The referrer's
     * parse-time source supplies files + jsonPath (the location of the
     * broken {@code extends:} on disk); referrer = the declaring node's bare
     * (short) name to match the TS/C#/Python reference (TS's MetaData
     * .fqn() does not propagate the root {@code package:} to root-level
     * objects); target = the unresolved supertype ref. Mirrors TS
     * {@code resolveDeferredSupers} in server/typescript/packages/metadata/
     * src/loader/meta-data-loader.ts.
     */
    private void throwUnresolvedSuper(PendingExtends p) {
        com.metaobjects.source.ErrorSource envelope =
            com.metaobjects.source.ResolvedSource.from(
                p.child.getSource(), p.child.getShortName(), p.superName);
        throw new com.metaobjects.MetaDataException(
            "Invalid MetaData [" + p.typeName + "][" + p.child.getShortName()
                + "], the SuperClass [" + p.superName + "] does not exist (deferred resolution)"
                + " in file [" + p.filename + "]",
            com.metaobjects.ErrorCode.ERR_UNRESOLVED_SUPER,
            envelope);
    }

    /**
     * FR-024 (ADR-0029): true when a ref's final {@code ::}-segment contains a
     * {@code .} — i.e. the ref targets a child nested inside an object
     * ({@code Customer.id}, {@code acme::sales::Customer.id}). Names cannot
     * contain {@code .}, so the form is unambiguous.
     */
    private static boolean isChildTargetingRef(String ref) {
        int lastSep = ref.lastIndexOf(PKG_SEPARATOR);
        String lastSegment = lastSep < 0 ? ref : ref.substring(lastSep + PKG_SEPARATOR.length());
        return lastSegment.indexOf('.') >= 0;
    }

    /**
     * FR-024 (ADR-0029): resolve just the OWNER object of a dotted child-targeting
     * ref — the {@code <ownerRef>} before the first {@code .} of the final
     * {@code ::}-segment. Uses the same pkg-prepend → referrer-ancestry-package →
     * FQN strategies as {@link #resolveChildTargetingRef}; returns {@code null}
     * when the owner object is not found (or the ref is not a well-formed dotted
     * ref). Extracted so #188's order-independent resolver can wire the owner's
     * OWN {@code extends} chain before the effective-children read.
     */
    private MetaData resolveOwnerObject(PendingExtends p) {
        int lastSep = p.superName.lastIndexOf(PKG_SEPARATOR);
        int segStart = lastSep < 0 ? 0 : lastSep + PKG_SEPARATOR.length();
        String lastSegment = p.superName.substring(segStart);
        String[] parts = lastSegment.split("\\.", -1);
        if (parts.length < 2) {
            return null;
        }
        for (String part : parts) {
            if (part.isEmpty()) {
                return null; // degenerate (empty segment)
            }
        }
        String ownerRef = p.superName.substring(0, segStart) + parts[0];

        MetaData owner = null;
        String pkg = p.packageName == null ? "" : p.packageName;
        if (ownerRef.indexOf(PKG_SEPARATOR) < 0 && !pkg.isEmpty()) {
            try {
                owner = getChildOfType(com.metaobjects.object.MetaObject.TYPE_OBJECT,
                    pkg + PKG_SEPARATOR + ownerRef);
            } catch (com.metaobjects.MetaDataNotFoundException ignore) {
                // fall through
            }
        }
        if (owner == null && ownerRef.indexOf(PKG_SEPARATOR) < 0) {
            // NESTED referrers (a field/identity inside an object) are queued with an
            // EMPTY packageName (the parser does not fold the object's package onto
            // nested children) — derive the context package from the referrer's
            // ancestry instead: the enclosing object's registered name carries the
            // parse-time-folded package (e.g. "fitness::ProgramView" → "fitness").
            // Mirrors TS resolveDeferredSupers' node.fileDefaultPackage fallback.
            for (MetaData ancestor = p.child.getParent(); ancestor != null; ancestor = ancestor.getParent()) {
                String ancestorPkg = ancestor.getPackage();
                if (ancestorPkg == null || ancestorPkg.isEmpty()) continue;
                try {
                    owner = getChildOfType(com.metaobjects.object.MetaObject.TYPE_OBJECT,
                        ancestorPkg + PKG_SEPARATOR + ownerRef);
                    break;
                } catch (com.metaobjects.MetaDataNotFoundException ignore) {
                    // keep walking up
                }
            }
        }
        if (owner == null) {
            try {
                owner = getChildOfType(com.metaobjects.object.MetaObject.TYPE_OBJECT, ownerRef);
            } catch (com.metaobjects.MetaDataNotFoundException ignore) {
                return null;
            }
        }
        return owner;
    }

    /**
     * FR-024 (ADR-0029): resolve a dotted child-targeting {@code extends} ref.
     * Splits {@code <rootRef>.<child>...<child>} (any depth), then selects the
     * owner's EFFECTIVE child (includeParentData) by name + the referrer's type.
     * The owner object is supplied by the caller ({@link #resolvePendingNode},
     * which resolves it first to wire its own {@code extends} chain per #188) —
     * resolved once, not re-resolved here. A resolved target whose type/subtype
     * differs from the referrer's throws {@code ERR_EXTENDS_TARGET_MISMATCH}
     * (dotted-only check).
     */
    private MetaData resolveChildTargetingRef(PendingExtends p, MetaData owner) {
        // Addressing model (ADR-0029): the package qualifies the ROOT-level node
        // only; each subsequent segment traverses CHILD NAMES to any depth
        // (object → field → view: "Customer.priceCents.display"). INTERMEDIATE
        // segments select by UNIQUE name among the current node's effective
        // children (a cross-type name collision is ambiguous → unresolved); the
        // FINAL segment is type-scoped to the referrer. Mirrors the TS reference.
        int lastSep = p.superName.lastIndexOf(PKG_SEPARATOR);
        int segStart = lastSep < 0 ? 0 : lastSep + PKG_SEPARATOR.length();
        String lastSegment = p.superName.substring(segStart);
        String[] parts = lastSegment.split("\\.", -1);
        if (parts.length < 2) {
            return null;
        }
        for (String part : parts) {
            if (part.isEmpty()) {
                return null; // degenerate (empty segment)
            }
        }
        if (owner == null) {
            return null;
        }

        // Traverse INTERMEDIATE segments by unique child name (effective view);
        // a missing name or a cross-type collision (e.g. a field AND an identity
        // both named "id") is unresolved.
        MetaData current = owner;
        for (int i = 1; i < parts.length - 1; i++) {
            String seg = parts[i];
            MetaData match = null;
            for (MetaData c : current.getChildren(MetaData.class, true)) {
                if (seg.equals(c.getName())) {
                    if (match != null) {
                        return null; // ambiguous intermediate
                    }
                    match = c;
                }
            }
            if (match == null) {
                return null;
            }
            current = match;
        }

        MetaData target;
        try {
            // FINAL segment: type-scoped + EFFECTIVE (includeParentData) — a field
            // ref selects among fields (own + inherited), an identity ref among
            // identities, a view ref among views. Nested child names are BARE
            // (the FR-024 addressing model: a package qualifies root-level
            // metadata only).
            target = current.getChildOfType(p.child.getType(), parts[parts.length - 1]);
        } catch (com.metaobjects.MetaDataNotFoundException notFound) {
            return null;
        }

        // #310 — type must match exactly; subtype must match too, with ONE exception on
        // identities. ADR-0040 encodes uniqueness in the TYPE, so primary and secondary are
        // both UNIQUE KEYS and differ only in which one the entity nominated as its main
        // handle. Borrowing a key borrows uniqueness, not that nomination — so a read model
        // may key off a business key the entity models as identity.secondary while never
        // surfacing its surrogate identity.primary. identity.reference stays out: a foreign
        // key is not unique, so it can never back a borrowed key.
        boolean compatible = target.getType().equals(p.child.getType())
                && (target.getSubType().equals(p.child.getSubType())
                    || (com.metaobjects.identity.MetaIdentity.TYPE_IDENTITY.equals(p.child.getType())
                        && com.metaobjects.identity.MetaIdentity.isUniqueKeySubType(p.child.getSubType())
                        && com.metaobjects.identity.MetaIdentity.isUniqueKeySubType(target.getSubType())));
        if (!compatible) {
            com.metaobjects.source.ErrorSource envelope =
                com.metaobjects.source.ResolvedSource.from(
                    p.child.getSource(), p.child.getShortName(), p.superName);
            throw new com.metaobjects.MetaDataException(
                "Invalid MetaData [" + p.typeName + "][" + p.child.getShortName()
                    + "], the dotted extends target [" + p.superName + "] is ["
                    + target.getType() + "." + target.getSubType() + "] but the extending node is ["
                    + p.child.getType() + "." + p.child.getSubType()
                    + "] — a dotted extends must target a node of the same type and subtype"
                    + " — the one exception is an identity, which may extend any UNIQUE key"
                    + " (identity.primary or identity.secondary)"
                    + " in file [" + p.filename + "]",
                com.metaobjects.ErrorCode.ERR_EXTENDS_TARGET_MISMATCH,
                envelope);
        }
        return target;
    }

    /**
     * Convenience constructor accepting only a name.
     * Uses {@link LoaderOptions} defaults (no-register, non-verbose, strict) and
     * {@link #SUBTYPE_MANUAL} as the subType.
     *
     * <p>This constructor satisfies the {@code Constructor(String)} reflection contract
     * required by {@code AbstractMetaDataMojo.getConfiguredLoader()} when
     * {@code MetaDataLoader} is specified as the loader classname in a Maven plugin
     * configuration.</p>
     *
     * @param name the loader name
     */
    public MetaDataLoader(String name) {
        this(LoaderOptions.create(false, false, true), SUBTYPE_MANUAL, name);
    }

    /**
     * Constructs a new MetaDataLoader
     * @param subtype The subType for the metadata loader
     */
    public MetaDataLoader(LoaderOptions loaderOptions, String subtype ) {
        this( loaderOptions, subtype, TYPE_LOADER + "-" + System.currentTimeMillis());
    }

    /**
     * Constructs a new MetaDataLoader
     * @param subtype The subtype of the metadata loader
     * @param name The name of the metadata loader
     */
    public MetaDataLoader(LoaderOptions loaderOptions, String subtype, String name ) {
        this.loaderOptions = loaderOptions;
        this.subType = subtype;
        this.name = name;
        // Produce the tree-root node. The root's name must satisfy the metadata
        // identifier pattern, so loader-name hyphens are normalized to underscores.
        // When the loader name is empty we fall back to a sentinel and mark the
        // root as synthesized so the canonical serializer does not leak it as a
        // top-level `package`.
        boolean synthesized = (name == null || name.isEmpty());
        this.root = new MetaRoot( sanitizeRootName( name ) );
        this.root.setLoader( this );
        if (synthesized) {
            this.root.markSynthesizedName();
        }
    }

    /** Normalize a loader name into a metadata-identifier-safe root name. */
    private static String sanitizeRootName(String loaderName) {
        if (loaderName == null || loaderName.isEmpty()) return "root";
        return loaderName.replace('-', '_');
    }

    /**
     * Manually construct a MetaDataLoader.  Usually used for unit testing.
     * @param name The name of the Manually create MetaDataLoader
     * @return The created MetaDataLoader
     */
    public static MetaDataLoader createManual( boolean shouldRegister, String name ) {
        return new MetaDataLoader(
                LoaderOptions.create( false, false, false),
                        SUBTYPE_MANUAL, name );
    }

    ///////////////////////////////////////////////////////////////////////
    // Unified static factories (cross-language consistent — see TS / C# / Python)

    /**
     * Build a {@link DirectorySource} for the given path and load all files
     * in deterministic order. Convenience for the 99% case.
     *
     * @param name      the loader name
     * @param directory the directory containing metadata files
     * @return a fully-initialized loader with all directory files loaded
     */
    public static MetaDataLoader fromDirectory(String name, Path directory) {
        return fromDirectory(name, directory, new DirectorySource.Options());
    }

    /**
     * Build a {@link DirectorySource} for the given path with the supplied
     * options and load all matching files.
     *
     * @param name      the loader name
     * @param directory the directory containing metadata files
     * @param opts      expansion options (exclude list, recursion)
     * @return a fully-initialized loader with all directory files loaded
     */
    public static MetaDataLoader fromDirectory(String name, Path directory, DirectorySource.Options opts) {
        MetaDataLoader loader = createManual(false, name);
        try {
            loader.init();
            List<MetaDataSource> sources = new DirectorySource(directory, opts).expandToList();
            loader.load(sources);
            loader.register();
        } catch (MetaDataLoadingException e) {
            throw e;
        } catch (Exception e) {
            throw new MetaDataLoadingException(
                "Failed to load from directory " + directory, name,
                loader.getLoadingState().getCurrentPhase(), 0, e);
        }
        return loader;
    }

    /**
     * Build {@link UriSource}s and load them. The cross-language URI-based
     * factory — every port (TS/Java/C#/Python) exposes the same shape.
     *
     * <p>Uses {@link #createManual(boolean, String)} defaults
     * ({@code shouldRegister=false, verbose=false, strict=false}). Callers that
     * need a different {@link LoaderOptions} (e.g. {@code strict=true}) should
     * use {@link #fromUris(String, List, LoaderOptions)}.</p>
     *
     * @param name the loader name
     * @param uris model URIs to load
     * @return a fully-initialized loader with all URIs loaded
     */
    public static MetaDataLoader fromUris(String name, List<URI> uris) {
        return fromUris(name, uris, null);
    }

    /**
     * Build {@link UriSource}s and load them with the supplied options.
     *
     * <p>Preserves the caller's {@link LoaderOptions} (notably {@code strict},
     * which {@link #createManual(boolean, String)} defaults to {@code false}).
     * Pass {@code null} to use the {@code createManual} defaults.</p>
     *
     * @param name the loader name
     * @param uris model URIs to load
     * @param opts loader options (may be {@code null} for defaults)
     * @return a fully-initialized loader with all URIs loaded
     */
    public static MetaDataLoader fromUris(String name, List<URI> uris, LoaderOptions opts) {
        MetaDataLoader loader = (opts == null)
            ? createManual(false, name)
            : new MetaDataLoader(opts, SUBTYPE_MANUAL, name);
        try {
            loader.init();
            List<MetaDataSource> sources = new ArrayList<>(uris.size());
            for (URI uri : uris) sources.add(new UriSource(uri));
            loader.load(sources);
            loader.register();
        } catch (MetaDataLoadingException e) {
            throw e;
        } catch (Exception e) {
            throw new MetaDataLoadingException(
                "Failed to load from URIs", name,
                loader.getLoadingState().getCurrentPhase(), 0, e);
        }
        return loader;
    }

    /**
     * Load a list of classpath resource paths. Each path is wrapped as a
     * {@code model:resource:<path>} URI and routed through {@link #fromUris(String, List)}.
     *
     * @param name      the loader name
     * @param resources classpath resource paths (no {@code model:} prefix needed)
     * @return a fully-initialized loader with all resources loaded
     */
    public static MetaDataLoader fromResources(String name, List<String> resources) {
        return fromResources(name, resources, null);
    }

    /**
     * Load a list of classpath resource paths with the supplied options.
     *
     * <p>Symmetric with {@link #fromUris(String, List, LoaderOptions)} — preserves
     * caller-supplied {@link LoaderOptions} (notably {@code strict}).</p>
     *
     * @param name      the loader name
     * @param resources classpath resource paths (no {@code model:} prefix needed)
     * @param opts      loader options (may be {@code null} for defaults)
     * @return a fully-initialized loader with all resources loaded
     */
    public static MetaDataLoader fromResources(String name, List<String> resources, LoaderOptions opts) {
        List<URI> uris = new ArrayList<>();
        for (String r : resources) uris.add(URIHelper.toURI("model:resource:" + r));
        return fromUris(name, uris, opts);
    }

    /**
     * Load a single in-memory string of the given format.
     *
     * @param name    the loader name
     * @param content the raw document content
     * @param format  the document format
     * @return a fully-initialized loader with the inline content loaded
     */
    public static MetaDataLoader fromString(String name, String content, MetaDataSource.MetaDataFormat format) {
        MetaDataLoader loader = createManual(false, name);
        try {
            loader.init();
            loader.load(List.of(new InMemoryStringSource(content, "<inline>", format)));
            loader.register();
        } catch (MetaDataLoadingException e) {
            throw e;
        } catch (Exception e) {
            throw new MetaDataLoadingException(
                "Failed to load from string", name,
                loader.getLoadingState().getCurrentPhase(), 0, e);
        }
        return loader;
    }

    ///////////////////////////////////////////////////////////////////////
    // Identity

    /** Returns the loader name. */
    public String getName() {
        return name;
    }

    /** Returns the loader subType. */
    public String getSubType() {
        return subType;
    }

    /** Returns the loader type — always {@link #TYPE_LOADER}. */
    public String getType() {
        return TYPE_LOADER;
    }

    /** Returns the short (unqualified) loader name. */
    public String getShortName() {
        int i = name.lastIndexOf(MetaData.PKG_SEPARATOR);
        return i >= 0 ? name.substring(i + MetaData.PKG_SEPARATOR.length()) : name;
    }

    ///////////////////////////////////////////////////////////////////////
    // Root access (H3a Task 4)

    /**
     * Returns the {@link MetaRoot} tree-root node this loader produces and owns.
     * Loaded metadata attaches as children of this root.
     *
     * @return the owned MetaRoot; never null
     */
    public MetaRoot getRoot() {
        return root;
    }

    /**
     * {@inheritDoc}
     * <p>The loader is a {@link LoaderConfigurable}; {@code getLoader()} returns
     * the loader itself.</p>
     */
    @Override
    public MetaDataLoader getLoader() {
        return this;
    }

    ///////////////////////////////////////////////////////////////////////
    // Validation warnings (cross-language warning surface)

    /**
     * Returns the validation warnings produced by the most recent {@link #load(List)}
     * call (or accumulated across multiple loads in this batch). The list is reset
     * at the start of every {@link #load(List)} invocation.
     *
     * <p>Warnings are non-fatal advisory messages emitted by {@link ValidationPhase}.
     * Errors continue to be eager-thrown — only warnings accumulate here.</p>
     *
     * <p>Mirrors the TS/C#/Python warning surfaces; the canonical consumer is the
     * conformance harness comparing against {@code expected-warnings.json}.</p>
     *
     * @return an unmodifiable snapshot of the accumulated warnings (never {@code null})
     */
    public List<String> getWarnings() {
        return Collections.unmodifiableList(new ArrayList<>(warnings));
    }

    /**
     * Append a validation warning. Package-private — only the loader-package
     * validation passes ({@link ValidationPhase}) should be calling this.
     *
     * @param warning the warning message; ignored when {@code null} or empty
     */
    void addWarning(String warning) {
        if (warning == null || warning.isEmpty()) return;
        warnings.add(warning);
    }

    /**
     * Clear accumulated warnings. Called at the start of {@link #load(List)} so
     * a fresh batch does not see stale warnings from a prior load on the same
     * loader instance.
     */
    void clearWarnings() {
        warnings.clear();
    }

    /**
     * Returns the validation errors RECORDED by the most recent {@link #load(List)}
     * call. The list is reset at the start of every {@link #load(List)} invocation.
     *
     * <p>The Java loader is eager-throw: hard errors raised from any phase
     * abort the load. This list captures errors that a phase COLLECTED before a
     * subsequent throw (or, in a future evolution, instead of throwing) so
     * downstream consumers — primarily the conformance harness — can see the
     * full set of errors from one load attempt rather than only the first.</p>
     *
     * <p>Today the list is typically empty (no phase records errors here),
     * which preserves the current behaviour: harnesses extract the single code
     * from the thrown {@link MetaDataException} and that's the per-load
     * error-set. Phases may begin emitting into this list as needs arise; the
     * harness side merges {@link #getErrors()} with the thrown exception so
     * either form is honoured.</p>
     *
     * @return an unmodifiable snapshot of recorded errors (never {@code null})
     */
    public List<MetaDataException> getErrors() {
        return Collections.unmodifiableList(new ArrayList<>(errors));
    }

    /**
     * Append a validation error. Loader-internal API — callers are the
     * loader's validation passes and the FR5c merge-attribution site in
     * {@link com.metaobjects.loader.parser.json.CanonicalJsonParser} (which
     * lives in a sub-package, so this method must be {@code public} for
     * cross-package access — mirroring the precedent set by
     * {@link #addPendingExtends(PendingExtends)}).
     *
     * @param error the error to record; ignored when {@code null}
     */
    public void addError(MetaDataException error) {
        if (error == null) return;
        errors.add(error);
    }

    /**
     * Clear accumulated errors. Called at the start of {@link #load(List)} so
     * a fresh batch does not see stale errors from a prior load on the same
     * loader instance.
     */
    void clearErrors() {
        errors.clear();
    }

    /**
     * Returns the FR5c envelope-shaped warnings accumulated during the most
     * recent {@link #load(List)}. Each entry carries a {@code WARN_*} code
     * plus a {@link com.metaobjects.source.ErrorSource} envelope (canonical
     * first emitter: {@code WARN_DUPLICATE_DECLARATION} with
     * {@link com.metaobjects.source.MergedSource}).
     *
     * <p>Cross-port aligned with the TS {@code ParseResult.envelopeWarnings}
     * channel and the C# / Python {@code LoaderWarning[]} return surfaces.</p>
     *
     * @return an unmodifiable snapshot of envelope warnings (never {@code null})
     */
    public List<com.metaobjects.source.LoaderWarning> getEnvelopeWarnings() {
        return Collections.unmodifiableList(new ArrayList<>(envelopeWarnings));
    }

    /**
     * Append a FR5c envelope-shaped warning. Loader-internal API — callers
     * are the loader pipeline plus the FR5c merge-attribution site in
     * {@link com.metaobjects.loader.parser.json.CanonicalJsonParser} (which
     * lives in a sub-package, so this method must be {@code public} for
     * cross-package access — mirroring the precedent set by
     * {@link #addPendingExtends(PendingExtends)}).
     *
     * <p>This method ALSO pushes the warning's {@link
     * com.metaobjects.source.LoaderWarning#message()} into the legacy
     * {@link #warnings} channel so the existing conformance harness — which
     * reads a flat string list via {@link #getWarnings()} — picks up FR5c
     * warnings without needing a new contract. The envelope is available
     * separately via {@link #getEnvelopeWarnings()} for callers that want
     * the full provenance.</p>
     *
     * @param warning the envelope warning; ignored when {@code null}
     */
    public void addEnvelopeWarning(com.metaobjects.source.LoaderWarning warning) {
        if (warning == null) return;
        envelopeWarnings.add(warning);
        // Mirror into the legacy channel for the conformance harness.
        warnings.add(warning.message());
    }

    /**
     * Clear accumulated envelope warnings. Called at the start of
     * {@link #load(List)} so a fresh batch does not see stale entries.
     */
    void clearEnvelopeWarnings() {
        envelopeWarnings.clear();
    }

    ///////////////////////////////////////////////////////////////////////
    // ClassLoader

    /**
     * Sets the ClassLoader used to resolve metadata-referenced Java classes.
     * @param <T> the loader type for fluent chaining
     * @param classLoader the ClassLoader to use
     * @return this loader
     */
    @SuppressWarnings("unchecked")
    public <T extends MetaDataLoader> T setMetaDataClassLoader( ClassLoader classLoader ) {
        this.metaDataClassLoader = classLoader;
        return (T) this;
    }

    protected ClassLoader getDefaultMetaDataClassLoader() {
        return getClass().getClassLoader();
    }

    public ClassLoader getMetaDataClassLoader() {
        if (metaDataClassLoader != null) {
            return metaDataClassLoader;
        }
        return getDefaultMetaDataClassLoader();
    }

    ///////////////////////////////////////////////////////////////////////
    // Source URIs (H3a Task 5: lifted from SimpleLoader)

    /**
     * Set the URI list to be loaded during {@link #init()}.
     *
     * @param sourceURIs list of model URIs; must not be {@code null}
     * @return this loader (for fluent chaining)
     */
    @SuppressWarnings("unchecked")
    public <T extends MetaDataLoader> T setSourceURIs(List<URI> sourceURIs) {
        this.sourceURIs = sourceURIs;
        return (T) this;
    }

    /**
     * Returns the URI list set via {@link #setSourceURIs}, or {@code null} if none was set.
     */
    public List<URI> getSourceURIs() {
        return sourceURIs;
    }

    ///////////////////////////////////////////////////////////////////////
    // Configs

    public LoaderOptions getLoaderOptions() {
        return loaderOptions;
    }

    public MetaDataRegistry getTypeRegistry() {
        if (typeRegistry == null) {
            // ADR-0023 Decision 2 — the JVM load-time pivot. Default to the sealed,
            // defined-metamodel-provider-set registry (the cross-port logical
            // vocabulary), NOT the unbounded classpath-SPI getInstance() singleton
            // (which the codegen-base/om doc-generator providers pollute with
            // ai*/json*/object.managed tooling vocabulary). Downstream apps that
            // need extra vocabulary use setTypeRegistry(compose(...)) — their own
            // unsealed registry.
            typeRegistry = com.metaobjects.registry.RegistryManifest.defaultLoaderRegistry();
        }
        return typeRegistry;
    }

    public MetaDataLoader setTypeRegistry(MetaDataRegistry typeRegistry) {
        this.typeRegistry = typeRegistry;
        return this;
    }

    public MetaDataLoaderRegistry getLoaderRegistry() {
        if (loaderRegistry == null) {
            loaderRegistry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        }
        return loaderRegistry;
    }

    public MetaDataLoader setLoaderRegistry(MetaDataLoaderRegistry loaderRegistry) {
        this.loaderRegistry = loaderRegistry;
        return this;
    }

    /**
     * Check the state of the MetaDataLoader to ensure it is initialized and not destroyed.
     */
    protected void checkState() {
        if (!loadingState.isUsable()) {
            throw new IllegalStateException(
                String.format("MetaDataLoader [%s] is not usable. %s",
                    getName(), loadingState.getStatusDescription()));
        }
    }

    /**
     * Get the current loading state
     * @return The LoadingState instance
     */
    public LoadingState getLoadingState() {
        return loadingState;
    }

    /**
     * Check if the loader is currently loading
     * @return true if loading is in progress
     */
    public boolean isLoading() {
        return loadingState.isLoadingInProgress();
    }

    /**
     * Get detailed status information
     * @return String describing the current loader status
     */
    public String getDetailedStatus() {
        return String.format("MetaDataLoader[%s] %s", getName(), loadingState.getStatusDescription());
    }

    /**
     * Build a unique key for THIS loader instance for concurrent loading protection.
     * Includes {@link #instanceId} so the {@code activeLoaders} dedup only ever
     * coalesces concurrent {@code init()} on the same instance (#233). Package-private
     * for {@code LoaderKeyIsolationTest}.
     */
    String buildLoaderKey() {
        return String.format("%s:%s:%s:%d",
                getClass().getSimpleName(), getSubType(), getName(), instanceId);
    }

    /**
     * Check if this loader is currently being initialized by another thread
     * @return true if initialization is in progress
     */
    public boolean isInitializationInProgress() {
        String loaderKey = buildLoaderKey();
        CompletableFuture<MetaDataLoader> future = activeLoaders.get(loaderKey);
        return future != null && !future.isDone();
    }

    /**
     * Get the number of loaders currently being initialized
     * @return Number of active initializations
     */
    public static int getActiveInitializationCount() {
        return (int) activeLoaders.values().stream().filter(f -> !f.isDone()).count();
    }

    /**
     * Force cleanup of failed or stale loader initialization attempts
     * @param loaderKey The key of the loader to cleanup, or null to cleanup all failed attempts
     */
    public static void cleanupFailedInitializations(String loaderKey) {
        if (loaderKey != null) {
            CompletableFuture<MetaDataLoader> future = activeLoaders.get(loaderKey);
            if (future != null && (future.isDone() || future.isCompletedExceptionally())) {
                activeLoaders.remove(loaderKey);
                log.debug("Cleaned up failed initialization for loader: {}", loaderKey);
            }
        } else {
            activeLoaders.entrySet().removeIf(entry -> {
                CompletableFuture<MetaDataLoader> future = entry.getValue();
                if (future.isDone() || future.isCompletedExceptionally()) {
                    log.debug("Cleaned up initialization for loader: {}", entry.getKey());
                    return true;
                }
                return false;
            });
        }
    }

    /**
     * Retry initialization with error extraction
     * @param maxRetries Maximum number of retry attempts
     * @param retryDelayMs Delay between retries in milliseconds
     * @return This MetaDataLoader
     * @throws MetaDataLoadingException if all retries fail
     */
    public MetaDataLoader initWithRetry(int maxRetries, long retryDelayMs) {
        MetaDataLoadingException lastException = null;

        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    log.debug("Retrying initialization for loader [{}], attempt {} of {}",
                           getName(), attempt + 1, maxRetries + 1);

                    resetForRetry();

                    if (retryDelayMs > 0) {
                        Thread.sleep(retryDelayMs);
                    }
                }

                return init();

            } catch (MetaDataLoadingException e) {
                lastException = e;
                log.warn("Initialization attempt {} failed for loader [{}]: {}",
                        attempt + 1, getName(), e.getMessage());

                cleanupFailedInitializations(buildLoaderKey());

                if (attempt == maxRetries) {
                    break;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new MetaDataLoadingException(
                    "Initialization retry interrupted for loader: " + getName(), e);
            }
        }

        throw new MetaDataLoadingException(
            "Failed to initialize loader [" + getName() + "] after " + (maxRetries + 1) + " attempts",
            getName(), LoadingState.Phase.INITIALIZING, 0, lastException);
    }

    /**
     * Reset loader state for retry attempts
     */
    private void resetForRetry() {
        loadingState.forceTransition(LoadingState.Phase.UNINITIALIZED);
        loadingState.clearError();

        if (typeRegistry != null || loaderRegistry != null) {
            log.debug("Clearing partial registry state for retry");
            typeRegistry = null;
            loaderRegistry = null;
        }

        log.debug("Reset loader state for retry: {}", getName());
    }

    /**
     * Graceful shutdown with cleanup
     */
    public void shutdown() {
        try {
            log.info("Shutting down MetaDataLoader [{}]", getName());

            String loaderKey = buildLoaderKey();
            CompletableFuture<MetaDataLoader> future = activeLoaders.get(loaderKey);
            if (future != null && !future.isDone()) {
                future.cancel(true);
                log.debug("Cancelled active initialization for loader: {}", loaderKey);
            }

            if (!isDestroyed()) {
                destroy();
            }

            cleanupFailedInitializations(loaderKey);

            log.info("Successfully shut down MetaDataLoader [{}]", getName());

        } catch (Exception e) {
            log.error("Error during shutdown of MetaDataLoader [{}]", getName(), e);
        }
    }

    ////////////////////////////////////////////////////////////////////////////////////////////
    // LoaderConfigurable Support Methods
    private String configSourceDir = null;

    @Override
    public void configure(LoaderConfiguration config) {
        if (config.getClassLoader() != null) {
            if (log.isDebugEnabled()) log.debug("Setting ClassLoader: " + config.getClassLoader());
            setMetaDataClassLoader(config.getClassLoader());
        }

        if (config.getSourceDir() != null) {
            File sd = new File(config.getSourceDir());
            if (!sd.exists()) throw new IllegalStateException("SourceDir [" + config.getSourceDir() + "] does not exist");
            if (log.isDebugEnabled()) log.debug("Setting SourceDir: " + config.getSourceDir());
            configSourceDir = config.getSourceDir();
        }

        if (config.getSources() != null && !config.getSources().isEmpty()) {
            if (log.isDebugEnabled()) log.debug("Processing sources: " + config.getSources());
            processSources(configSourceDir, config.getSources());
        }

        processArguments(config.getArguments());
        init();
    }

    /**
     * Convert a list of source strings to URIs and store them for loading during {@link #init()}.
     * Each string may be a bare path (resolved against {@code sourceDir} or the classpath) or a
     * fully-qualified {@code model:…} URI string.  This is the same logic that used to live in
     * {@code SimpleLoader.processSources()} and is invoked by {@link #configure(LoaderConfiguration)}.
     */
    protected void processSources(String sourceDir, List<String> sourceList) {
        if (sourceList == null) throw new IllegalArgumentException(
                "sourceList was null on processSources for " + getName());

        List<URI> uris = new ArrayList<>();
        for (String s : sourceList) {
            if (s.indexOf(':') < 0) {
                if (sourceDir != null) {
                    s = "model:file:" + s + ";" + com.metaobjects.loader.uri.URIHelper.URI_ARG_SOURCEDIR + "=" + sourceDir;
                } else if (new File(s).exists()) {
                    s = "model:file:" + s;
                } else {
                    s = "model:resource:" + s;
                }
            }
            uris.add(URIHelper.toURI(s));
        }
        setSourceURIs(uris);
    }

    protected void processArguments(Map<String, String> args) {
        if (args == null) return;

        if (args.get(LoaderConfigurationConstants.ARG_REGISTER) != null) {
            getLoaderOptions().setShouldRegister(Boolean.parseBoolean(args.get(LoaderConfigurationConstants.ARG_REGISTER)));
        }
        if (args.get(LoaderConfigurationConstants.ARG_VERBOSE) != null) {
            getLoaderOptions().setVerbose(Boolean.parseBoolean(args.get(LoaderConfigurationConstants.ARG_VERBOSE)));
        }
        if (args.get(LoaderConfigurationConstants.ARG_STRICT) != null) {
            getLoaderOptions().setStrict(Boolean.parseBoolean(args.get(LoaderConfigurationConstants.ARG_STRICT)));
        }
    }

    ////////////////////////////////////////////////////////////////////////////////////////////
    // Initialization Methods

    protected void initDefaultRegistries() {
        if (typeRegistry == null) {
            // ADR-0023 Decision 2 — default to the sealed defined-provider-set
            // registry (see getTypeRegistry()), not the polluted SPI singleton.
            typeRegistry = com.metaobjects.registry.RegistryManifest.defaultLoaderRegistry();
            log.debug("Initialized default (sealed metamodel) MetaDataRegistry for loader: {}", getName());
        }

        if (loaderRegistry == null) {
            loaderRegistry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
            log.debug("Initialized default MetaDataLoaderRegistry for loader: {}", getName());
        }
    }

    /**
     * Initialize the MetaDataLoader with enhanced thread-safe state management and concurrent protection.
     * @return This MetaDataLoader
     * @throws MetaDataLoadingException if initialization fails
     */
    public MetaDataLoader init() {
        return initWithConcurrencyProtection(DEFAULT_LOADING_TIMEOUT_MS);
    }

    /**
     * Initialize the MetaDataLoader with concurrent protection and custom timeout.
     * @param timeoutMs Maximum time to wait for initialization in milliseconds
     * @return This MetaDataLoader
     * @throws MetaDataLoadingException if initialization fails or times out
     */
    public MetaDataLoader initWithTimeout(long timeoutMs) {
        return initWithConcurrencyProtection(timeoutMs);
    }

    /**
     * Internal initialization method with concurrent protection
     */
    private MetaDataLoader initWithConcurrencyProtection(long timeoutMs) {
        // #233: deterministically warm the process-global registry singletons on the
        // caller thread BEFORE any parallel first-init can race their independent locks.
        // Covers every loader embedder (Spring, parallel test runners, servers), not
        // just Maven. Idempotent (no-op after the first init in this JVM).
        com.metaobjects.registry.RegistryBootstrap.warmUpDefaults();
        String loaderKey = buildLoaderKey();

        CompletableFuture<MetaDataLoader> loadingFuture = activeLoaders.computeIfAbsent(loaderKey,
            key -> CompletableFuture.supplyAsync(() -> performInitialization(key),
                                               ForkJoinPool.commonPool()));

        try {
            return loadingFuture.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            activeLoaders.remove(loaderKey);
            throw new MetaDataLoadingException(
                "Loader initialization timeout after " + timeoutMs + "ms: " + loaderKey,
                getName(), LoadingState.Phase.INITIALIZING, timeoutMs, e);
        } catch (InterruptedException | ExecutionException e) {
            activeLoaders.remove(loaderKey);
            Throwable cause = e instanceof ExecutionException ? e.getCause() : e;
            throw new MetaDataLoadingException(
                "Loader initialization failed: " + loaderKey,
                getName(), LoadingState.Phase.INITIALIZING, 0, cause);
        }
    }

    /**
     * Internal method that performs the actual initialization work
     */
    private MetaDataLoader performInitialization(String loaderKey) {
        long startTime = System.currentTimeMillis();

        try {
            return performInitializationInternal(startTime);
        } catch (Exception e) {
            throw new RuntimeException("Failed to initialize loader: " + loaderKey, e);
        } finally {
            activeLoaders.remove(loaderKey);
        }
    }

    /**
     * Core initialization logic
     */
    private MetaDataLoader performInitializationInternal(long startTime) {
        validateAndTransitionToInitializing();

        try {
            logInitializationStart();
            initializeRegistriesIfNeeded();
            loadSourceURIsIfPresent();
            transitionToInitialized(startTime);
            registerIfRequested();
            logInitializationSuccess(startTime);

            return this;

        } catch (Exception e) {
            handleInitializationFailure(e, startTime);
            throw e;
        }
    }

    /**
     * If {@link #sourceURIs} has been populated (e.g. via {@link #setSourceURIs} or
     * {@link #processSources}), parse each URI into this loader's {@link MetaRoot}.
     * Called automatically from {@link #performInitializationInternal} so that
     * {@code setSourceURIs(...).init()} is the standard URI-based loading pattern.
     *
     * <p>Each URI is wrapped in a {@link UriSource} (which infers JSON vs XML
     * from the file extension) and routed through the canonical
     * {@link #load(List)} method, ensuring a single parser-dispatch path.</p>
     */
    private void loadSourceURIsIfPresent() {
        if (sourceURIs == null || sourceURIs.isEmpty()) return;

        List<MetaDataSource> sources = new ArrayList<>();
        for (URI uri : sourceURIs) {
            sources.add(new UriSource(uri));
        }
        load(sources);
    }

    private void validateAndTransitionToInitializing() {
        if (!loadingState.tryTransition(LoadingState.Phase.UNINITIALIZED, LoadingState.Phase.INITIALIZING)) {
            LoadingState.Phase currentPhase = loadingState.getCurrentPhase();
            if (currentPhase == LoadingState.Phase.INITIALIZED || currentPhase == LoadingState.Phase.REGISTERED) {
                throw new IllegalStateException("MetaDataLoader [" + getName() + "] was already initialized");
            } else {
                throw new IllegalStateException("MetaDataLoader [" + getName() + "] cannot be initialized from phase: " + currentPhase);
            }
        }
    }

    private void logInitializationStart() {
        if (loaderOptions.isVerbose()) {
            log.info("Loading the [" + getClass().getSimpleName() + "] MetaDataLoader with name [" + getName() + "]");
        }
    }

    private void initializeRegistriesIfNeeded() {
        if (typeRegistry == null || loaderRegistry == null) {
            initDefaultRegistries();
        }
    }

    private void transitionToInitialized(long startTime) {
        if (!loadingState.tryTransition(LoadingState.Phase.INITIALIZING, LoadingState.Phase.INITIALIZED)) {
            throw new MetaDataLoadingException(
                "Failed to transition to INITIALIZED phase",
                getName(), loadingState.getCurrentPhase(),
                System.currentTimeMillis() - startTime);
        }
    }

    private void registerIfRequested() {
        if (loaderOptions.shouldRegister()) {
            register();
        }
    }

    private void logInitializationSuccess(long startTime) {
        if (loaderOptions.isVerbose()) {
            log.info("Successfully loaded MetaDataLoader [" + getName() + "] in " +
                    (System.currentTimeMillis() - startTime) + "ms");
        }
    }

    private void handleInitializationFailure(Exception e, long startTime) {
        loadingState.setError(e, LoadingState.Phase.UNINITIALIZED);

        if (!(e instanceof MetaDataLoadingException)) {
            throw new MetaDataLoadingException(
                "Failed to initialize MetaDataLoader [" + getName() + "]",
                getName(), LoadingState.Phase.INITIALIZING,
                System.currentTimeMillis() - startTime, e);
        }
    }

    /**
     * Returns if the MetaDataLoader is initialized
     * @return True if initialized
     */
    public boolean isInitialized() {
        return loadingState.isInPhase(LoadingState.Phase.INITIALIZED, LoadingState.Phase.REGISTERED);
    }

    /**
     * Register this MetaDataLoader using enhanced state management
     */
    public MetaDataLoader register() {
        if (!loadingState.tryTransition(LoadingState.Phase.INITIALIZED, LoadingState.Phase.REGISTERING)) {
            LoadingState.Phase currentPhase = loadingState.getCurrentPhase();
            if (currentPhase == LoadingState.Phase.REGISTERED) {
                return this;
            } else {
                throw new IllegalStateException(
                    "Cannot register MetaDataLoader [" + getName() + "] from phase: " + currentPhase);
            }
        }

        try {
            if (!loadingState.tryTransition(LoadingState.Phase.REGISTERING, LoadingState.Phase.REGISTERED)) {
                throw new IllegalStateException(
                    "Failed to transition to REGISTERED phase for MetaDataLoader [" + getName() + "]");
            }

            // FR-031: the tree is now load-complete and immutable — freeze every
            // node so the resolving read-path accessors (getChildren/getMetaAttrs/
            // isArrayType) may memoize their extends-chain walks (frozen-only, so
            // nothing computed during the mutable load phase is cached stale).
            if (root != null) {
                root.freeze();
            }

            if (loaderOptions.isVerbose()) {
                log.info("Successfully registered MetaDataLoader [" + getName() + "]");
            }

            return this;

        } catch (Exception e) {
            loadingState.setError(e, LoadingState.Phase.INITIALIZED);
            throw new MetaDataLoadingException(
                "Failed to register MetaDataLoader [" + getName() + "]",
                getName(), LoadingState.Phase.REGISTERING, 0, e);
        }
    }

    /**
     * Returns whether the MetaDataLoader is registered
     */
    public boolean isRegistered() {
        return loadingState.isInPhase(LoadingState.Phase.REGISTERED);
    }

    ////////////////////////////////////////////////////////////////////////////////////////////
    // Source-based load pipeline (H3a Task 4)

    /**
     * Load metadata from a list of {@link MetaDataSource} instances. Each source's
     * raw content is read and parsed into this loader's {@link MetaRoot}; parsed
     * nodes accumulate on the root across sources. Mirrors the TypeScript
     * {@code MetaDataLoader.load(MetaDataSource[])} pipeline.
     *
     * <p>This is a thin wrapper over the existing parser machinery — it routes
     * each source to the JSON or XML parser based on {@link MetaDataSource#getFormat()}.
     * The loader must already be initialized (see {@link #init()}).</p>
     *
     * @param sources the sources to consume, in order
     * @return this loader
     */
    public MetaDataLoader load(List<MetaDataSource> sources) {
        if (sources == null) throw new IllegalArgumentException("sources must not be null");

        // Reset the per-load warning + error accumulators so callers see only
        // diagnostics produced by THIS batch.
        clearWarnings();
        clearErrors();
        clearEnvelopeWarnings();
        pendingExtends.clear();

        // #160 — this loader merges DURING parse (each source is streamed into the
        // accumulating MetaRoot). A source that ONLY re-opens objects declared
        // elsewhere (every top-level object carries `overlay: true`) must therefore
        // be parsed AFTER the sources that declare those base objects, or the
        // overlaid node lands ahead of its base entities — leaving a projection
        // before its base so order-dependent super-resolution can't resolve its
        // `extends`/`@via`, and the streaming merge errors ERR_OVERLAY_NO_TARGET.
        // Directory discovery order is not guaranteed to present base files first
        // (basename sort can put an overlay-only file first), so stable-partition
        // overlay-only sources to the END here, making the merge order-independent.
        // Stable within each group preserves last-writer-wins overlay semantics.
        sources = partitionOverlayLast(sources);

        for (MetaDataSource source : sources) {
            String content;
            try {
                content = source.read();
            } catch (IOException e) {
                throw new MetaDataLoadingException(
                    "Failed to read metadata source [" + source.getId() + "]: " + e.getMessage(),
                    getName(), LoadingState.Phase.INITIALIZING, 0, e);
            }

            // Dispatch by format: canonical JSON → CanonicalJsonParser; sigil-free
            // authoring YAML → ParserYaml (which desugars to canonical JSON before
            // calling the same buildTree). ADR-0006 D4.
            InputStream is = new ByteArrayInputStream(content.getBytes(StandardCharsets.UTF_8));
            com.metaobjects.loader.parser.MetaDataFileParser parser;
            if (source.getFormat() == MetaDataSource.MetaDataFormat.YAML) {
                parser = new ParserYaml(this, source.getId());
            } else {
                parser = new CanonicalJsonParser(this, source.getId());
            }
            parser.loadFromStream(is);
        }

        // Resolve any deferred {@code extends} refs before validation runs —
        // cross-file forward references show up here. Anything still unresolved
        // becomes ERR_UNRESOLVED_SUPER.
        resolvePendingExtends();

        // Run post-load validation passes after all sources in this batch are parsed.
        // Fires both when called from init() (via loadSourceURIsIfPresent) and when
        // called directly by tests or the conformance runner. The loader handle is
        // passed so non-fatal validation findings can be recorded via
        // {@link #addWarning(String)} (errors continue to be eager-thrown).
        ValidationPhase.run(root, this);

        return this;
    }

    // ------------------------------------------------------------------------
    // #160 — overlay-only source partition (stable, overlay-only sources last)
    // ------------------------------------------------------------------------

    /**
     * Stable-partition {@code sources} so that "overlay-only" sources — every
     * top-level object declaration carries {@code overlay: true}, i.e. the source
     * declares no base objects of its own and only re-opens objects declared
     * elsewhere — are parsed LAST. Preserves original order within each group.
     *
     * <p>A source whose content can't be read or structurally scanned stays in the
     * base group (never overlay-only) — this partition must never crash the loader;
     * any genuine read/parse failure surfaces later, in the real parse loop.</p>
     */
    private static List<MetaDataSource> partitionOverlayLast(List<MetaDataSource> sources) {
        List<MetaDataSource> base = new ArrayList<>();
        List<MetaDataSource> overlayOnly = new ArrayList<>();
        for (MetaDataSource source : sources) {
            boolean isOverlayOnly = false;
            try {
                isOverlayOnly = isOverlayOnlySource(source.read(), source.getFormat());
            } catch (Exception e) {
                isOverlayOnly = false;
            }
            (isOverlayOnly ? overlayOnly : base).add(source);
        }
        base.addAll(overlayOnly);
        return base;
    }

    /**
     * Structurally scan a source's raw content (JSON via Gson; sigil-free authoring
     * YAML via SnakeYAML → Gson — {@code overlay: true} is a bare key before desugar)
     * and report whether every top-level object declaration under
     * {@code metadata.root.children} carries {@code overlay: true} (and there is at
     * least one).
     */
    private static boolean isOverlayOnlySource(String content, MetaDataSource.MetaDataFormat format) {
        if (content == null) return false;
        // Strip UTF-8 BOM (mirrors CanonicalJsonParser / ParserYaml).
        String normalized = (!content.isEmpty() && content.charAt(0) == '﻿')
            ? content.substring(1) : content;
        JsonElement parsed;
        if (format == MetaDataSource.MetaDataFormat.YAML) {
            Object loaded = new org.yaml.snakeyaml.Yaml().load(normalized);
            parsed = new Gson().toJsonTree(loaded);
        } else {
            parsed = JsonParser.parseString(normalized);
        }
        return rootIsOverlayOnly(parsed);
    }

    /**
     * True when the structurally-parsed root has &ge;1 child and every top-level
     * child node carries {@code overlay: true} (declares no base objects).
     */
    private static boolean rootIsOverlayOnly(JsonElement parsed) {
        if (parsed == null || !parsed.isJsonObject()) return false;
        JsonElement rootBodyEl = parsed.getAsJsonObject().get("metadata.root");
        if (rootBodyEl == null || !rootBodyEl.isJsonObject()) return false;
        JsonElement childrenEl = rootBodyEl.getAsJsonObject().get(BaseMetaDataParser.ATTR_CHILDREN);
        if (childrenEl == null || !childrenEl.isJsonArray()) return false;
        JsonArray children = childrenEl.getAsJsonArray();
        if (children.size() == 0) return false;
        for (JsonElement childEl : children) {
            if (childEl == null || !childEl.isJsonObject()) return false;
            JsonObject child = childEl.getAsJsonObject();
            if (child.size() == 0) return false;
            // Each child is a single-key wrapper: { "object.projection": { ... } }.
            for (Map.Entry<String, JsonElement> entry : child.entrySet()) {
                JsonElement bodyEl = entry.getValue();
                if (bodyEl == null || !bodyEl.isJsonObject()) return false;
                JsonElement overlayEl = bodyEl.getAsJsonObject().get(BaseMetaDataParser.ATTR_OVERLAY);
                boolean isOverlay = overlayEl != null
                    && overlayEl.isJsonPrimitive()
                    && overlayEl.getAsJsonPrimitive().isBoolean()
                    && overlayEl.getAsBoolean();
                if (!isOverlay) return false;
            }
        }
        return true;
    }

    ////////////////////////////////////////////////////////////////////////////////////////////
    // Node-style QUERY accessors — read-only delegations to the owned MetaRoot.
    //
    // As of H3a Task 4 the loader carries no node identity. Tree MUTATION
    // (addChild/clearChildren/addMetaAttr) is NOT exposed here — callers that
    // need to build the tree must do so through {@link #getRoot()}.

    /** Wrap the MetaDataLoader (unsupported). */
    public MetaDataLoader overload() {
        throw new IllegalStateException( "You cannot wrap a MetaDataLoader!" );
    }

    /** Returns all direct children of the root node. */
    public List<MetaData> getChildren() {
        return root.getChildren();
    }

    /** Returns all children of the root node of the given class. */
    public <N extends MetaData> List<N> getChildren(Class<N> c) {
        return root.getChildren(c);
    }

    /** Returns all children of the root node of the given class. */
    public <N extends MetaData> List<N> getChildren(Class<N> c, boolean includeParentData) {
        return root.getChildren(c, includeParentData);
    }

    /** Returns the root child with the given type and name. */
    public MetaData getChildOfType(String type, String name) throws MetaDataNotFoundException {
        return root.getChildOfType(type, name);
    }

    /** Returns the root child with the given name and class. */
    public <T extends MetaData> T getChild(String name, Class<T> c) throws MetaDataNotFoundException {
        return root.getChild(name, c);
    }

    /**
     * Whether the MetaDataLoader handles the object specified
     */
    protected boolean handles(Object obj) {
        checkState();
        return getMetaObjectFor(obj) != null;
    }

    /**
     * Retrieves a collection of all MetaData of the specified type
     */
    public List<MetaData> getMetaDataOfType( String type ) {
        return getMetaDataOfType(type, true);
    }

    /**
     * Retrieves a collection of all MetaData of the specified type
     */
    public List<MetaData> getMetaDataOfType( String type, boolean includeParentData ) {
        checkState();
        return root.getChildrenOfType(type, includeParentData);
    }

    /**
     * Retrieves a collection of all MetaObjects
     */
    public List<MetaObject> getMetaObjects() {
        checkState();
        return root.getChildren( MetaObject.class, true );
    }

    /**
     * Retrieves a MetaObject by name
     */
    public MetaObject getMetaObjectByName(String name ) {
        checkState();
        return (MetaObject) root.getChildOfType( MetaObject.TYPE_OBJECT, name );
    }

    /**
     * Return the matching object instance
     */
    @SuppressWarnings("unchecked")
    public <T> T newObjectInstance(Class<T> clazz) throws ClassNotFoundException {
        for(MetaObject mo : getMetaObjects()) {
            if (mo.getObjectClass().equals(clazz)) {
                return (T) mo.newInstance();
            }
        }
        throw new ClassNotFoundException("Could not find MetaObject for class ["+clazz.getName()+"]");
    }

    /**
     * Gets the MetaObject of the specified Object
     */
    public MetaObject getMetaObjectFor(Object obj) {
        checkState();
        for (MetaObject mc : root.getChildren( MetaObject.class, true )) {
            if (mc.produces(obj)) {
                return mc;
            }
        }
        return null;
    }

    /**
     * Retrieves a collection of all MetaData of the specified Class type
     */
    public <N extends MetaData> List<N> getMetaData(Class<N> c ) {
        return getMetaData(c, true);
    }

    /**
     * Retrieves a collection of all MetaData of the specified Class type
     */
    public <N extends MetaData> List<N> getMetaData( Class<N> c, boolean includeParentData ) {
        checkState();
        return root.getChildren(c, includeParentData);
    }

    /**
     * Gets the MetaData with the specified Class type and name
     */
    @SuppressWarnings("unchecked")
    public <N extends MetaData> N getMetaDataByName( Class<N> c, String metaDataName) throws MetaDataNotFoundException {

        checkState();

        String KEY = "QuickCache-"+c.getName()+"-"+metaDataName;

        MetaData mc = (MetaData) root.getCacheValue(KEY);
        if (mc == null) {
            synchronized( this ) {
                mc = (MetaData) root.getCacheValue(KEY);
                if (mc == null) {
                    for (MetaData mc2 : getMetaData( c )) {
                        if (mc2.getName().equals(metaDataName)) {
                            mc = mc2;
                            break;
                        }
                    }
                    if (mc != null) {
                        root.setCacheValue(KEY, mc);
                    }
                }
            }

            if (mc == null) {
                throw new MetaDataNotFoundException( "MetaData with name [" + metaDataName + "] not found in MetaDataLoader [" + toString() + "]", metaDataName );
            }
        }

        return (N) mc;
    }

    /**
     * Gets the MetaData with the specified name in parent hierarchy.
     * Only uses direct 'super' relationship, not 'inherits'
     */
    @SuppressWarnings("unchecked")
    protected List<MetaObject> getMetaDataBySuper(String metaDataName, List<MetaObject> objects) throws MetaDataNotFoundException {

        checkState();

        String KEY = "QuickCacheDerived-" + metaDataName;
        List<MetaObject> result = (List<MetaObject>) root.getCacheValue(KEY);
        if (result == null) {
            synchronized (this) {
                result = (List<MetaObject>) root.getCacheValue(KEY);
                if (result == null) {
                    result = new ArrayList<>();

                    for (MetaObject mo : objects) {
                        if (null != mo.getSuperObject()) {
                            if (mo.getSuperObject().getName().equals(metaDataName)) {
                                result.add( mo);
                                result.addAll( getMetaDataBySuper(mo.getName(), objects));
                            }
                        }
                    }
                    root.setCacheValue(KEY, result);
                }
            }
        }
        return result;
    }

    /**
     * Gets the MetaData with the specified name in parent hierarchy.
     * Only uses direct 'super' relationship, not 'inherits'
     */
    @SuppressWarnings("unchecked")
    public List<MetaObject> getMetaDataBySuper(String metaDataName) throws MetaDataNotFoundException {

        checkState();

        String KEY = "QuickCacheDerived-" + metaDataName;
        List<MetaObject> result = (List<MetaObject>) root.getCacheValue(KEY);
        if (result == null) {
            synchronized (this) {
                result = (List<MetaObject>) root.getCacheValue(KEY);
                if (result == null) {
                    List<MetaObject> objects = getMetaObjects();
                    result = getMetaDataBySuper(metaDataName, objects);
                }
            }
        }

        return result;
    }

    /**
     * Lookup the specified class by name
     */
    public Class<?> loadClass(String className ) throws ClassNotFoundException {

        checkState();
        try {
            return getClass().getClassLoader().loadClass( className );
        } catch (ClassNotFoundException e) {
            throw new ClassNotFoundException("Specified Java Class [" + className + "] was not found: " + e.getMessage(), e);
        }
    }

    /**
     * Unloads the MetaDataLoader with enhanced state management
     */
    public void destroy() {
        if (loadingState.isDestroyed()) {
            throw new IllegalStateException("MetaDataLoader [" + getName() + "] was already destroyed!");
        }

        if (loaderOptions.isVerbose()) {
            log.info("Destroying the [" + getName() + "] MetaDataLoader");
        }

        try {
            root.clearChildren();

            loadingState.forceTransition(LoadingState.Phase.DESTROYED);

            if (loaderOptions.isVerbose()) {
                log.info("Successfully destroyed MetaDataLoader [" + getName() + "]");
            }

        } catch (Exception e) {
            loadingState.setError(e);
            log.error("Error during destruction of MetaDataLoader [" + getName() + "]", e);
            throw new RuntimeException("Failed to destroy MetaDataLoader [" + getName() + "]", e);
        }
    }

    public boolean isDestroyed() {
        return loadingState.isDestroyed();
    }

    ////////////////////////////////////////////////////
    // MISC METHODS

    public String toString() {
        return getClass().getSimpleName() + "[" + getSubType() + ":" + getName() + "]";
    }

}
