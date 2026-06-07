package com.metaobjects.agentcontext;

import java.util.List;
import java.util.Set;

/**
 * The resolved tech-stack of a consumer project — the input to the agent-context
 * assembler.
 *
 * <p>Cross-port contract (must match the TypeScript / Python references exactly):
 * <ul>
 *   <li>{@code servers} — deduped, in {@link #SERVER_LANGS} order.</li>
 *   <li>{@code clients} — deduped, in {@link #CLIENT_FRAMEWORKS} order.</li>
 *   <li>{@code tokens} — {@code servers ∪ clients ∪ {"migration"}}, the
 *       install-selection set used to choose which reference fragments to emit.</li>
 * </ul>
 *
 * <p>Use {@link #of(List, List)} to build one: it dedupes + canonical-orders the
 * inputs and derives the token set. The canonical orderings are the allow-list —
 * unknown entries are dropped — so the result is exactly {@link #SERVER_LANGS} /
 * {@link #CLIENT_FRAMEWORKS} filtered to the requested set (matching the TS/Python
 * {@code makeStack}).
 */
public final class Stack {

    /** Server languages, in canonical dedupe order. */
    public static final List<String> SERVER_LANGS =
            List.of("typescript", "java", "kotlin", "csharp", "python");

    /** Client frameworks, in canonical dedupe order. */
    public static final List<String> CLIENT_FRAMEWORKS =
            List.of("react", "tanstack", "angular");

    /** Always-present token: schema migrations are TS-owned for every port (ADR-0015). */
    public static final String MIGRATION_TOKEN = "migration";

    /** The five skills, in the exact emit order (matches the TS/Python references). */
    public static final List<String> SKILL_NAMES = List.of(
            "metaobjects-authoring",
            "metaobjects-codegen",
            "metaobjects-runtime-ui",
            "metaobjects-prompts",
            "metaobjects-verify");

    private final List<String> servers;
    private final List<String> clients;
    private final Set<String> tokens;

    private Stack(List<String> servers, List<String> clients, Set<String> tokens) {
        this.servers = servers;
        this.clients = clients;
        this.tokens = tokens;
    }

    /**
     * Build a {@link Stack}: dedupe + canonical-order the inputs, derive tokens.
     * Unknown entries are dropped (the canonical orderings are the allow-list).
     */
    public static Stack of(List<String> servers, List<String> clients) {
        List<String> s = SERVER_LANGS.stream().filter(servers::contains).toList();
        List<String> c = CLIENT_FRAMEWORKS.stream().filter(clients::contains).toList();
        java.util.LinkedHashSet<String> t = new java.util.LinkedHashSet<>();
        t.addAll(s);
        t.addAll(c);
        t.add(MIGRATION_TOKEN);
        return new Stack(s, c, Set.copyOf(t));
    }

    /** Deduped servers, in {@link #SERVER_LANGS} order. */
    public List<String> servers() {
        return servers;
    }

    /** Deduped clients, in {@link #CLIENT_FRAMEWORKS} order. */
    public List<String> clients() {
        return clients;
    }

    /** {@code servers ∪ clients ∪ {"migration"}} — the install-selection set. */
    public Set<String> tokens() {
        return tokens;
    }
}
