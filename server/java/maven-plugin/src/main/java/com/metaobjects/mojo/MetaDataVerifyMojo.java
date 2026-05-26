package com.metaobjects.mojo;

import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.ResolutionScope;

/**
 * Maven goal: {@code meta:verify} — CI drift detection.
 *
 * <p>Thin wrapper that delegates to {@link MetaDataMigrateMojo} with {@code verb="verify"}.
 * Fails the build if the live DB schema drifts from the metadata-declared schema. Designed
 * to run in CI on every PR alongside the codegen-kotlin generator output.</p>
 *
 * <p>All other mojo parameters (jdbcUrl, jdbcUser, jdbcPassword, jdbcDriver, databaseDriver,
 * loader, allowDrop*) flow through unchanged.</p>
 */
@Mojo(name = "verify",
      defaultPhase = LifecyclePhase.VERIFY,
      requiresDependencyResolution = ResolutionScope.COMPILE_PLUS_RUNTIME)
public class MetaDataVerifyMojo extends MetaDataMigrateMojo {

    @Override
    public void execute() throws MojoExecutionException, MojoFailureException {
        // Force verb=verify regardless of pom config.
        try {
            java.lang.reflect.Field verbField = MetaDataMigrateMojo.class.getDeclaredField("verb");
            verbField.setAccessible(true);
            verbField.set(this, "verify");
        } catch (Exception e) {
            throw new MojoExecutionException("failed to force verify verb", e);
        }
        super.execute();
    }
}
