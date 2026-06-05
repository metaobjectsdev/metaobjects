package com.metaobjects.agentcontext;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * The pure agent-context assembler.
 *
 * <p>Port of {@code server/typescript/packages/sdk/src/agent-context/assemble.ts}
 * (and the Python {@code metaobjects.agent_context.assemble}). Given the content
 * tree and a resolved {@link Stack}, produce the {@code (path, contents)} files the
 * consumer project receives — BYTE-IDENTICAL to the TS/Python references.
 *
 * <p>BYTE-IDENTITY: every file but the two always-on documents is a verbatim copy.
 * We read raw bytes and decode UTF-8 with no newline translation, and emit a
 * {@code String} whose UTF-8 encoding is the original bytes. The only computed
 * content is the two always-on template substitutions. Output is sorted by path
 * ascending using {@link String#compareTo} — the same codepoint ordering the
 * TS/Python ports use.
 */
public final class AgentContextAssembler {

    /** {@code {{key}}} template-variable pattern (word chars only, matching the TS regex). */
    private static final Pattern TEMPLATE_VAR = Pattern.compile("\\{\\{(\\w+)\\}\\}");

    private AgentContextAssembler() {
    }

    /**
     * Assemble the consumer files for a resolved stack. Pure given the content tree.
     *
     * <p>Output is sorted by path ascending — the stable order the conformance gate
     * and the TS/Python references both produce.
     *
     * @param contentRoot the repo-root {@code agent-context/} content tree.
     * @param stack       the resolved consumer stack.
     * @return the {@code (path, contents)} files, sorted by path ascending.
     */
    public static List<AssembledFile> assemble(Path contentRoot, Stack stack) {
        List<AssembledFile> out = new ArrayList<>();

        // 1. Always-on (AGENTS.md + CLAUDE.md, identical contents).
        String tpl = readText(contentRoot.resolve("templates").resolve("always-on.md.mustache"));
        String[] computed = stackLine(contentRoot, stack);
        String alwaysOn = applyTemplate(tpl, Map.of(
                "stackLine", computed[0],
                "codegenCommand", computed[1]));
        out.add(new AssembledFile(".metaobjects/AGENTS.md", alwaysOn));
        out.add(new AssembledFile(".metaobjects/CLAUDE.md", alwaysOn));

        // 2. Skills: body + only the references whose token is in the stack.
        for (String skill : Stack.SKILL_NAMES) {
            Path skillDir = contentRoot.resolve("skills").resolve(skill);
            String body = readText(skillDir.resolve("SKILL.md"));
            out.add(new AssembledFile(".claude/skills/" + skill + "/SKILL.md", body));

            Path refDir = skillDir.resolve("references");
            if (Files.isDirectory(refDir)) {
                // Tokens (filename-without-".md") in the stack, sorted ascending.
                TreeSet<String> tokens = new TreeSet<>();
                try (Stream<Path> s = Files.list(refDir)) {
                    s.filter(Files::isRegularFile)
                            .map(p -> p.getFileName().toString())
                            .filter(n -> n.endsWith(".md"))
                            .map(n -> n.substring(0, n.length() - ".md".length()))
                            .filter(stack.tokens()::contains)
                            .forEach(tokens::add);
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
                for (String token : tokens) {
                    out.add(new AssembledFile(
                            ".claude/skills/" + skill + "/references/" + token + ".md",
                            readText(refDir.resolve(token + ".md"))));
                }
            }
        }

        // Stable order: by path (plain codepoint ordering, matching TS/Python).
        out.sort(Comparator.comparing(AssembledFile::path));
        return out;
    }

    /** Read a file as UTF-8 with NO newline translation (byte-faithful). */
    private static String readText(Path path) {
        try {
            return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("agent-context: failed to read " + path, e);
        }
    }

    /** Load {@code servers/<server>.meta.json}, or {@code null} if absent. */
    private static JsonObject readServerMeta(Path contentRoot, String server) {
        Path p = contentRoot.resolve("servers").resolve(server + ".meta.json");
        if (!Files.exists(p)) {
            return null;
        }
        return JsonParser.parseString(readText(p)).getAsJsonObject();
    }

    /**
     * Compute {@code [stackLine, codegenCommand]} for the always-on template.
     *
     * <p>{@code codegenCommand} is the FIRST server's {@code codegenCommand} (or
     * {@code "meta gen"} if there is no primary server, or its meta file is absent).
     */
    private static String[] stackLine(Path contentRoot, Stack stack) {
        String primary = stack.servers().isEmpty() ? null : stack.servers().get(0);
        JsonObject meta = primary != null ? readServerMeta(contentRoot, primary) : null;
        String serverPart = stack.servers().isEmpty()
                ? "no server"
                : String.join(", ", stack.servers()) + " server";
        String clientPart = stack.clients().isEmpty()
                ? "no client"
                : String.join(", ", stack.clients()) + " client";
        String line = "Stack: " + serverPart + ", " + clientPart + "; migrations are TS.";
        String codegenCommand = meta != null
                ? meta.get("codegenCommand").getAsString()
                : "meta gen";
        return new String[]{line, codegenCommand};
    }

    /** Replace every {@code {{key}}}; throw on an unknown key (matches TS/Python). */
    private static String applyTemplate(String tpl, Map<String, String> variables) {
        Matcher m = TEMPLATE_VAR.matcher(tpl);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            String key = m.group(1);
            String value = variables.get(key);
            if (value == null) {
                throw new IllegalArgumentException(
                        "agent-context: unknown template variable {{" + key + "}}");
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(value));
        }
        m.appendTail(sb);
        return sb.toString();
    }
}
