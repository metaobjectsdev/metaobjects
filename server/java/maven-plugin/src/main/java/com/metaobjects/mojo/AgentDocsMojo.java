package com.metaobjects.mojo;

import org.apache.maven.plugin.AbstractMojo;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;

import java.util.List;

/**
 * {@code metaobjects:agent-docs} — scaffolds the MetaObjects Claude Code agent context.
 *
 * <p><strong>This goal is no longer implemented in the Maven plugin.</strong> Agent-context
 * scaffolding has moved to the {@code meta} CLI. Run:
 * <pre>
 *   npx meta agent-docs --server java [--client &lt;fw&gt;] [--out &lt;dir&gt;]
 * </pre>
 */
@Mojo(name = "agent-docs", requiresProject = false, defaultPhase = LifecyclePhase.NONE)
public class AgentDocsMojo extends AbstractMojo {

    /** Server languages (e.g. {@code java}, {@code kotlin}). */
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
        getLog().warn("agent-context scaffolding moved to the meta CLI — run: "
                + "npx meta agent-docs --server java [--client <fw>] [--out <dir>]");
        throw new MojoExecutionException(
                "agent-docs is no longer implemented in the Maven plugin; use the meta CLI.");
    }
}
