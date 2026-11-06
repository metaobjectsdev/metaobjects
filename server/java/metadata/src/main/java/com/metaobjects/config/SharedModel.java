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
package com.metaobjects.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.FileSource;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.loader.References;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.registry.RegistryManifest;
import com.metaobjects.requirement.MetaRequirement;
import com.metaobjects.template.TemplateConstants;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * FR-023 — the publisher's half of a shared model: the flattened artifact and the manifest that
 * pins it, the pair a consumer's {@code meta deps sync} copies into its own repo and verifies
 * (design §2.2, §3.2, §3.5). Mirrors {@code codegen-ts/src/shared-model/build-shared-model.ts};
 * the shared corpus {@code fixtures/shared-model-conformance/} pins the bytes and the refusals.
 *
 * <p>Two stages, both pure of the run, and both in the package on purpose. A generator an
 * application owns ({@code mvn metaobjects:eject -Dnames=shared-model}) decides which source files
 * may contribute and which version is published, and calls these for everything a consumer checks:
 * what is selected, that the selection is closed, the document's bytes, the hash over them, and the
 * manifest's shape and file names. An owned copy that changed any of those would publish an
 * artifact a consumer's sync refuses, or worse, accepts and cannot load, so they are not in the
 * copy.</p>
 *
 * <ol>
 *   <li>{@link #build} — standalone strict load of {@code files} with the publisher's own
 *       providers; select top-level nodes (never {@code requirement.*} or {@code template.*}) by
 *       {@code include} / {@code exclude}; check the selection is closed over {@code extends} and
 *       every ref-bearing attribute; serialize; re-load the document with CORE providers only.</li>
 *   <li>{@link #render} — {@code <name>.metaobjects.json} and {@code metaobjects.pkg.json}, the
 *       manifest carrying the sha256 of the artifact's bytes.</li>
 * </ol>
 */
public final class SharedModel {

    private SharedModel() {}

    /** The manifest's file name (design §3.2); the same constant {@link Dependencies#MANIFEST_FILE}. */
    public static final String MANIFEST_FILE = Dependencies.MANIFEST_FILE;

    /** The manifest schema's own version, distinct from {@code metamodelVersion}. */
    private static final int MANIFEST_SCHEMA_VERSION = 1;
    /** Pretty-printed, unescaped-HTML Gson for the manifest; Gson instances are thread-safe, so one is shared. */
    private static final Gson MANIFEST_GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    /** Why a publisher refused to publish; the corpus's {@code expectRefusal.reason}. */
    public enum Reason {
        EMPTY_SELECTION("empty-selection"),
        NOT_CLOSED("not-closed"),
        NON_CORE_VOCABULARY("non-core-vocabulary");

        private final String id;

        Reason(String id) {
            this.id = id;
        }

        /** The corpus spelling. */
        public String id() {
            return id;
        }
    }

    /** One {@code (referrer, target)} resolution-key pair the selection is not closed over. */
    public record Pair(String referrer, String target) {}

    /** A selection that cannot be published; carries the classified reason and, for not-closed, every pair. */
    public static final class Refusal extends MetaDataException {
        private static final long serialVersionUID = 1L;
        private final Reason reason;
        private final transient List<Pair> pairs;

        Refusal(Reason reason, String message, List<Pair> pairs) {
            super(message);
            this.reason = reason;
            this.pairs = List.copyOf(pairs);
        }

        public Reason reason() {
            return reason;
        }

        /** Sorted by referrer then target; empty unless {@link Reason#NOT_CLOSED}. */
        public List<Pair> pairs() {
            return pairs;
        }
    }

    /**
     * What to publish.
     *
     * @param name      the dependency key a consumer will sync under; also the artifact's basename
     * @param files     the publisher's own source files that may contribute, loaded standalone
     * @param include   scope patterns (the same grammar as {@code scope}); empty selects everything
     * @param exclude   applied after {@code include}
     * @param providers the publisher's own vocabulary providers, so its extra attributes load as
     *                  they did for the project's main load; empty = core vocabulary
     */
    public record Input(String name, List<Path> files, List<String> include, List<String> exclude,
                        List<MetaDataTypeProvider> providers) {
        public Input {
            files = List.copyOf(files);
            include = include == null ? List.of() : List.copyOf(include);
            exclude = exclude == null ? List.of() : List.copyOf(exclude);
            providers = providers == null ? List.of() : List.copyOf(providers);
        }
    }

    /**
     * A selection that passed every check, serialized. Produced by {@link #build} and consumed by
     * {@link #render}; the document is exactly the bytes that were re-loaded with core vocabulary,
     * and the manifest's hash is taken over them.
     *
     * @param document the canonical-JSON {@code metadata.root} document: the artifact's bytes
     * @param packages the metadata packages the selection spans, sorted
     * @param nodes    the resolution key of every selected top-level node, sorted
     */
    public record Built(String name, String document, List<String> packages, List<String> nodes) {}

    /** The two files a shared model is published as. */
    public record Files(String artifactPath, String artifact, String manifestPath, String manifest) {}

    /** {@code <name>.metaobjects.json}: the artifact's file name, as {@code meta deps sync} reads it. */
    public static String artifactFileName(String name) {
        return name + Dependencies.ARTIFACT_SUFFIX;
    }

    /**
     * Load {@code files} standalone, select by {@code include} / {@code exclude}, and return the
     * selection as a checked, serialized shared model (design §4.3 steps 1 to 5).
     *
     * @throws Refusal when the selection is empty, is not closed, or needs vocabulary a consumer's
     *         toolchain does not ship
     * @throws MetaDataException when the files do not load
     */
    public static Built build(Input input) {
        // Step 1: standalone strict load, the publisher's own providers.
        MetaDataLoader loader = load(input.providers(), sourcesOf(input.files()), "sharedModel");
        MetaData root = loader.getRoot();

        // Step 2: select. The root has no super chain (ADR-0039 sanctioned own read).
        Scope.Compiled scope = Scope.compileScope(input.include(), input.exclude());
        List<MetaData> selected = new ArrayList<>();
        for (MetaData node : root.getChildren(MetaData.class, false)) {
            if (node instanceof MetaAttribute) continue;
            if (MetaRequirement.TYPE_REQUIREMENT.equals(node.getType())
                    || TemplateConstants.TYPE_TEMPLATE.equals(node.getType())) continue;
            if (Scope.matchesScope(node.getName(), scope)) selected.add(node);
        }
        if (selected.isEmpty()) {
            throw new Refusal(Reason.EMPTY_SELECTION,
                "shared-model \"" + input.name() + "\": selected no nodes (include/exclude, always excluding "
                    + "requirement.* and template.*) - nothing to publish. Check `include`.", List.of());
        }

        // Step 3: closure.
        Set<String> selectedKeys = new HashSet<>();
        for (MetaData n : selected) selectedKeys.add(n.getName());
        List<Pair> failures = checkClosure(root, selected, selectedKeys);
        if (!failures.isEmpty()) {
            StringBuilder lines = new StringBuilder();
            for (Pair p : failures) lines.append("\n  ").append(p.referrer()).append(" -> ").append(p.target());
            throw new Refusal(Reason.NOT_CLOSED,
                "shared-model \"" + input.name() + "\": the selection is not closed - these references point "
                    + "outside it; include it or exclude the referrer:" + lines, failures);
        }

        // Step 4: serialize (sorted by resolution key).
        String document = CanonicalJsonSerializer.serializeSharedDocument(selected);

        // Step 5: re-load with CORE providers only. A consumer loads the artifact with ITS providers,
        // never the publisher's, so an export needing publisher-only vocabulary fails HERE.
        try {
            load(List.of(), List.of(new InMemoryStringSource(document, artifactFileName(input.name()))),
                "sharedModelCore");
        } catch (RuntimeException e) {
            throw new Refusal(Reason.NON_CORE_VOCABULARY,
                "shared-model \"" + input.name() + "\": the export needs a provider this toolchain does not "
                    + "ship; Phase 1 exports must load with core vocabulary: " + e.getMessage(), List.of());
        }

        Set<String> packages = new TreeSet<>();
        Set<String> nodes = new TreeSet<>();
        for (MetaData n : selected) {
            packages.add(Dependencies.packageOf(n.getName()));
            nodes.add(n.getName());
        }
        return new Built(input.name(), document, List.copyOf(packages), List.copyOf(nodes));
    }

    /**
     * The artifact and the manifest that pins it (design §4.3 step 6, §3.2): the manifest names the
     * artifact and carries the sha256 of its bytes, so the pair is rendered together and never one
     * without the other.
     */
    public static Files render(Built model, String version) {
        String artifactPath = artifactFileName(model.name());
        String integrity = Dependencies.sha256Integrity(model.document().getBytes(StandardCharsets.UTF_8));
        JsonObject manifest = new JsonObject();
        manifest.addProperty("schema_version", MANIFEST_SCHEMA_VERSION);
        manifest.addProperty("name", model.name());
        manifest.addProperty("version", version);
        manifest.addProperty("metamodelVersion", RegistryManifest.METAMODEL_VERSION);
        manifest.addProperty("artifact", artifactPath);
        manifest.addProperty("integrity", integrity);
        manifest.add("packages", array(model.packages()));
        manifest.add("nodes", array(model.nodes()));
        String text = MANIFEST_GSON.toJson(manifest) + "\n";
        return new Files(artifactPath, model.document(), MANIFEST_FILE, text);
    }

    private static JsonArray array(List<String> values) {
        JsonArray a = new JsonArray();
        for (String v : values) a.add(v);
        return a;
    }

    private static List<MetaDataSource> sourcesOf(List<Path> files) {
        List<MetaDataSource> out = new ArrayList<>();
        for (Path p : files) out.add(new FileSource(p));
        return out;
    }

    private static MetaDataLoader load(List<MetaDataTypeProvider> providers, List<MetaDataSource> sources,
                                       String name) {
        LoaderOptions options = LoaderOptions.create(false, false, true);
        if (!providers.isEmpty()) options.setProviders(providers);
        MetaDataLoader loader = new MetaDataLoader(options, MetaDataLoader.SUBTYPE_MANUAL, name);
        loader.init();
        loader.load(sources);
        List<MetaDataException> errors = loader.getErrors();
        if (errors != null && !errors.isEmpty()) throw errors.get(0);
        return loader;
    }

    // ------------------------------------------------------------------------------------
    // closure

    /** Depth-first walk of a node and its OWN descendants, node itself first. ADR-0039 sanctioned
     *  own-only case: the shared document emits each selected node's OWN layer only ({@code extends}
     *  preserved, not flattened), so the closure check walks exactly what will be emitted. */
    private static void walkOwn(MetaData node, List<MetaData> out) {
        out.add(node);
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            if (child instanceof MetaAttribute) continue;
            walkOwn(child, out);
        }
    }

    private static List<Pair> checkClosure(MetaData root, List<MetaData> selected, Set<String> selectedKeys) {
        Set<Pair> seen = new LinkedHashSet<>();
        for (MetaData top : selected) {
            String referrerKey = top.getName();
            List<MetaData> walk = new ArrayList<>();
            walkOwn(top, walk);
            for (MetaData node : walk) {
                List<String> candidates = new ArrayList<>();
                String superRef = node.getAuthoredSuperRef();
                if (superRef != null) candidates.add(superRef);
                // ADR-0039 sanctioned own-only case: an INHERITED ref-bearing attr belongs to the
                // base node's own layer and is checked when the base itself is walked.
                for (MetaAttribute<?> attr : node.getMetaAttrs(false)) {
                    if (!References.REF_BEARING_ATTR_NAMES.contains(attr.getName())) continue;
                    Object value = attr.getValue();
                    if (value instanceof String s) candidates.add(s);
                }
                if (candidates.isEmpty()) continue;
                String referrerPkg = References.effectivePackageOf(node);
                for (String raw : candidates) {
                    MetaData resolved = References.resolveObjectRef(root, References.splitChildTail(raw).owner(), referrerPkg).node();
                    if (resolved == null) continue; // already validated at load: defensive only
                    String targetKey = resolved.getName();
                    if (selectedKeys.contains(targetKey)) continue;
                    seen.add(new Pair(referrerKey, targetKey));
                }
            }
        }
        List<Pair> pairs = new ArrayList<>(seen);
        pairs.sort(Comparator.comparing(Pair::referrer).thenComparing(Pair::target));
        return pairs;
    }
}
