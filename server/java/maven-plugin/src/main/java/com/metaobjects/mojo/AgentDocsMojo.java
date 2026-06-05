package com.metaobjects.mojo;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.agentcontext.AgentContextAssembler;
import com.metaobjects.agentcontext.AgentContextScaffold;
import com.metaobjects.agentcontext.AssembledFile;
import com.metaobjects.agentcontext.ContentRoot;
import com.metaobjects.agentcontext.Stack;
import org.apache.maven.plugin.AbstractMojo;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code metaobjects:agent-docs} — scaffold the slim MetaObjects Claude Code agent
 * context for JVM (Java/Kotlin) adopters, without Node.
 *
 * <p>Resolves the stack from {@code <servers>} / {@code <clients>} plugin config (or
 * defaults to a {@code java} server when a {@code pom.xml} is present), assembles the
 * consumer files against the bundled {@code agent-context/} content tree
 * ({@link AgentContextAssembler}, byte-identical to the TS/Python references), and
 * writes them into {@code ${project.basedir}} (or {@code <outputDirectory>}):
 * <ul>
 *   <li>each new or manifest-unmodified file is written at its path;</li>
 *   <li>a hand-edited file's fresh contents go to {@code <path>.new} (the original
 *       is kept);</li>
 *   <li>the always-on import is appended to a root {@code CLAUDE.md}/{@code AGENTS.md}
 *       (idempotent; {@code CLAUDE.md} created if neither exists);</li>
 *   <li>a sidecar manifest ({@code .metaobjects/.agent-context.json}) records each
 *       file's sha256 so re-runs detect hand-edits.</li>
 * </ul>
 */
@Mojo(name = "agent-docs", requiresProject = false, defaultPhase = LifecyclePhase.NONE)
public class AgentDocsMojo extends AbstractMojo {

    /** Claude Code agent always picks up the slim always-on context. */
    private static final String[] ROOT_DOC_CANDIDATES = {"CLAUDE.md", "AGENTS.md"};
    private static final String ROOT_DOC_IMPORT_LINE = "@.metaobjects/AGENTS.md";

    private static final Gson MANIFEST_GSON =
            new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    /** Server languages (e.g. {@code java}, {@code kotlin}). Empty → detect from the project. */
    @Parameter(property = "metaobjects.servers")
    private List<String> servers;

    /** Client frameworks (e.g. {@code react}, {@code tanstack}). */
    @Parameter(property = "metaobjects.clients")
    private List<String> clients;

    /** Output directory; defaults to the project basedir (or cwd for a project-less run). */
    @Parameter(property = "metaobjects.outputDirectory", defaultValue = "${project.basedir}")
    private java.io.File outputDirectory;

    @Override
    public void execute() throws MojoExecutionException {
        Path outDir = (outputDirectory != null ? outputDirectory.toPath()
                : Path.of(System.getProperty("user.dir"))).toAbsolutePath();

        List<String> serverList = servers != null ? new ArrayList<>(servers) : new ArrayList<>();
        List<String> clientList = clients != null ? new ArrayList<>(clients) : new ArrayList<>();
        if (serverList.isEmpty() && clientList.isEmpty()) {
            if (Files.isRegularFile(outDir.resolve("pom.xml"))) {
                serverList.add("java");
            } else {
                throw new MojoExecutionException(
                        "no <servers>/<clients> configured and no pom.xml found to detect a "
                                + "stack. Configure at least one server or client.");
            }
        }

        Path contentRoot;
        try {
            // Prefer the classpath-bundled copy (published plugin); else walk up to the monorepo.
            contentRoot = ContentRoot.resolve(outDir);
        } catch (IllegalStateException e) {
            throw new MojoExecutionException(e.getMessage(), e);
        }

        Stack stack = Stack.of(serverList, clientList);
        List<AssembledFile> assembled = AgentContextAssembler.assemble(contentRoot, stack);

        // Load the prior manifest (if any) so hand-edits are preserved on re-run.
        Path manifestPath = outDir.resolve(AgentContextScaffold.MANIFEST_PATH);
        AgentContextScaffold.Manifest prior = readPriorManifest(manifestPath);

        AgentContextScaffold.ScaffoldDecision decision =
                AgentContextScaffold.plan(stack, assembled, prior, rel -> readCurrent(outDir, rel));

        try {
            for (AgentContextScaffold.Write w : decision.writes()) {
                writeFile(outDir.resolve(w.path()), w.contents());
                getLog().info("wrote " + w.path());
            }
            for (AgentContextScaffold.Conflict c : decision.conflicts()) {
                writeFile(outDir.resolve(c.newPath()), c.contents());
                getLog().info("hand-edited; wrote fresh copy to " + c.newPath()
                        + " (kept your " + c.path() + ")");
            }
            for (String rel : decision.removed()) {
                getLog().info("note: " + rel + " no longer applies to this stack (not deleted)");
            }

            // Persist the manifest.
            writeManifest(manifestPath, decision.manifest());

            String wired = wireRootDoc(outDir);
            if (wired != null) {
                getLog().info("wired " + ROOT_DOC_IMPORT_LINE + " into " + wired);
            }
        } catch (IOException e) {
            throw new MojoExecutionException("agent-docs: failed writing scaffold", e);
        }

        getLog().info("metaobjects:agent-docs: scaffolded " + assembled.size()
                + " file(s) for stack [servers=" + stack.servers()
                + ", clients=" + stack.clients() + "] into " + outDir);
    }

    private AgentContextScaffold.Manifest readPriorManifest(Path manifestPath) {
        if (!Files.isRegularFile(manifestPath)) {
            return null;
        }
        try {
            JsonObject obj = JsonParser.parseString(
                    new String(Files.readAllBytes(manifestPath), StandardCharsets.UTF_8))
                    .getAsJsonObject();
            return parseManifest(obj);
        } catch (RuntimeException | IOException e) {
            // Corrupt sidecar → treat as a fresh scaffold.
            getLog().warn("ignoring corrupt manifest at " + manifestPath + ": " + e.getMessage());
            return null;
        }
    }

    private static AgentContextScaffold.Manifest parseManifest(JsonObject obj) {
        Map<String, String> files = new LinkedHashMap<>();
        if (obj.has("files") && obj.get("files").isJsonObject()) {
            obj.getAsJsonObject("files").entrySet()
                    .forEach(e -> files.put(e.getKey(), e.getValue().getAsString()));
        }
        List<String> srv = jsonStrings(obj, "servers");
        List<String> cli = jsonStrings(obj, "clients");
        int version = obj.has("version") ? obj.get("version").getAsInt() : 1;
        return new AgentContextScaffold.Manifest(version, srv, cli, files);
    }

    private static List<String> jsonStrings(JsonObject obj, String key) {
        List<String> out = new ArrayList<>();
        if (obj.has(key) && obj.get(key).isJsonArray()) {
            obj.getAsJsonArray(key).forEach(e -> out.add(e.getAsString()));
        }
        return out;
    }

    private static String readCurrent(Path outDir, String rel) {
        Path p = outDir.resolve(rel);
        if (!Files.isRegularFile(p)) {
            return null;
        }
        try {
            return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static void writeFile(Path dest, String contents) throws IOException {
        Files.createDirectories(dest.getParent());
        Files.write(dest, contents.getBytes(StandardCharsets.UTF_8));
    }

    private void writeManifest(Path manifestPath, AgentContextScaffold.Manifest manifest)
            throws IOException {
        // Build an ordered JSON object: version, servers, clients, files.
        Map<String, Object> doc = new LinkedHashMap<>();
        doc.put("version", manifest.version());
        doc.put("servers", manifest.servers());
        doc.put("clients", manifest.clients());
        doc.put("files", manifest.files());
        Files.createDirectories(manifestPath.getParent());
        Files.write(manifestPath,
                (MANIFEST_GSON.toJson(doc) + "\n").getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Append {@code @.metaobjects/AGENTS.md} to the root CLAUDE.md/AGENTS.md.
     * Idempotent — if the import line is already present in either doc, do nothing.
     * If neither doc exists, create {@code CLAUDE.md} with the import line. Returns the
     * doc filename that was created/updated, or {@code null} if it was already wired.
     */
    private String wireRootDoc(Path outDir) throws IOException {
        List<String> existing = new ArrayList<>();
        for (String name : ROOT_DOC_CANDIDATES) {
            if (Files.isRegularFile(outDir.resolve(name))) {
                existing.add(name);
            }
        }
        for (String name : existing) {
            String text = new String(Files.readAllBytes(outDir.resolve(name)), StandardCharsets.UTF_8);
            if (text.contains(ROOT_DOC_IMPORT_LINE)) {
                return null; // already wired → idempotent no-op
            }
        }
        if (!existing.isEmpty()) {
            String name = existing.get(0);
            Path target = outDir.resolve(name);
            String text = new String(Files.readAllBytes(target), StandardCharsets.UTF_8);
            String sep = (text.endsWith("\n") || text.isEmpty()) ? "" : "\n";
            Files.write(target,
                    (text + sep + ROOT_DOC_IMPORT_LINE + "\n").getBytes(StandardCharsets.UTF_8));
            return name;
        }
        Path target = outDir.resolve("CLAUDE.md");
        Files.write(target, (ROOT_DOC_IMPORT_LINE + "\n").getBytes(StandardCharsets.UTF_8));
        return "CLAUDE.md";
    }
}
