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

import com.metaobjects.MetaRoot;
import com.metaobjects.loader.FileSource;
import com.metaobjects.loader.MetaDataSource;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.function.Predicate;

/**
 * FR-023 — what a project's dependencies resolved to: the snapshot artifacts that load FIRST, and
 * the predicates every action surface reads to decide whether an imported object is excluded
 * (DESIGN §11.1 item 2). The Java/Kotlin counterpart of Python's {@code Collection}.
 *
 * <p>{@link #inScope} is the Python shape — the import-exclusion half only. Java never applied
 * {@code scope} to its OWN generated output, so it is not invented here (the corpus cannot tell the
 * two shapes apart; see the dependency-conformance README, "Cross-port caveat").
 *
 * <p>An empty set (no dependencies, no lock) is the untouched project: nothing is imported, every
 * object is in scope and {@link #inMigrateScope()} is empty when no {@code migrate.scope} is declared.
 */
public final class DependencySet {

    /** The set of a project that declares no dependencies. */
    public static final DependencySet EMPTY =
            new DependencySet(List.of(), List.of(), null);

    private final List<Dependencies.ResolvedDependency> dependencies;
    private final List<String> scopeInclude;
    private final List<String> migrateScope;
    private final Set<String> importedPackages;
    private final Set<String> importedNodes;
    private final Scope.Compiled declaredMigrateScope;

    private DependencySet(List<Dependencies.ResolvedDependency> dependencies, List<String> scopeInclude,
                          List<String> migrateScope) {
        this.dependencies = List.copyOf(dependencies);
        this.scopeInclude = List.copyOf(scopeInclude);
        this.migrateScope = migrateScope == null ? null : List.copyOf(migrateScope);
        Set<String> packages = new HashSet<>();
        Set<String> nodes = new HashSet<>();
        for (Dependencies.ResolvedDependency d : this.dependencies) {
            packages.addAll(d.packages());
            nodes.addAll(d.nodes());
        }
        this.importedPackages = Set.copyOf(packages);
        this.importedNodes = Set.copyOf(nodes);
        this.declaredMigrateScope = this.migrateScope == null ? null : Scope.compileScope(this.migrateScope, null);
    }

    /**
     * Resolve the dependencies of the project whose {@code .metaobjects/} folder is under
     * {@code configDir}: read its neutral config, read and validate the lock, verify the committed
     * snapshot against it. Read at EVERY rung of the source ladder — a pom's {@code <sourceDir>}
     * changes where the project's own FILES come from, not where its dependencies are declared.
     */
    public static DependencySet resolve(Path configDir) {
        return of(configDir, NeutralConfig.read(configDir));
    }

    /** {@link #resolve(Path)} for a caller that has already read the neutral config. */
    public static DependencySet of(Path configDir, Optional<NeutralConfig> config) {
        List<java.util.Map<String, String>> specs = config.map(NeutralConfig::getDependencies).orElse(List.of());
        List<String> include = config.map(NeutralConfig::getScopeInclude).orElse(List.of());
        List<String> migrate = config.map(NeutralConfig::getMigrateScope).orElse(null);
        Optional<java.util.Map<String, Dependencies.LockEntry>> lock = Dependencies.readLock(configDir);
        List<Dependencies.ResolvedDependency> resolved = specs.isEmpty() && lock.isEmpty()
                ? List.of()
                : Dependencies.verifySnapshot(configDir, specs, lock);
        return new DependencySet(resolved, include, migrate);
    }

    /** The dependencies attached to a loaded tree ({@link MetaRoot#getDependencySet()}); never {@code null}. */
    public static DependencySet forRoot(MetaRoot root) {
        return root.getDependencySet();
    }

    /** The resolved dependencies, in dependency-NAME order. */
    public List<Dependencies.ResolvedDependency> dependencies() {
        return dependencies;
    }

    public boolean isEmpty() {
        return dependencies.isEmpty();
    }

    /** THE exclusion key (DESIGN §11.5): the union of every dependency's {@code packages}. */
    public Set<String> importedPackages() {
        return importedPackages;
    }

    /** The union of every dependency's {@code nodes}; read only by the ownership refusal. */
    public Set<String> importedNodes() {
        return importedNodes;
    }

    /** The artifacts as load sources, in dependency-NAME order, each under its {@code dep:<name>/<artifact>} id. */
    public List<MetaDataSource> sources() {
        List<MetaDataSource> out = new ArrayList<>(dependencies.size());
        for (Dependencies.ResolvedDependency d : dependencies) out.add(new FileSource(d.artifactPath(), d.sourceId()));
        return out;
    }

    /** Is {@code fqn} in a package one of this project's dependencies owns? */
    public boolean imported(String fqn) {
        return importedPackages.contains(Dependencies.packageOf(fqn));
    }

    /**
     * Output filter for codegen and {@code verify --codegen}: an object this project imports is not
     * its own to generate, unless {@code scope.include} NAMES its package.
     */
    public boolean inScope(String fqn) {
        String pkg = Dependencies.packageOf(fqn);
        if (!importedPackages.contains(pkg)) return true;
        return Dependencies.explicitlyIncludes(scopeInclude, pkg);
    }

    /**
     * The {@code migrate.scope}-governed predicate, or empty when the project declares no
     * {@code migrate.scope} AND imports nothing (empty means "govern everything loaded").
     */
    public Optional<Predicate<String>> inMigrateScope() {
        if (migrateScope == null && dependencies.isEmpty()) return Optional.empty();
        return Optional.of(fqn -> {
            if (declaredMigrateScope != null && !Scope.matchesScope(fqn, declaredMigrateScope)) return false;
            String pkg = Dependencies.packageOf(fqn);
            return !importedPackages.contains(pkg) || Dependencies.explicitlyIncludes(migrateScope, pkg);
        });
    }

    /** The post-load ownership refusal (DESIGN §11.5); call AFTER the loader's own errors. */
    public void refuseUnownedPackages(MetaRoot root) {
        Dependencies.refuseUnownedPackages(root, importedPackages, importedNodes);
    }
}
