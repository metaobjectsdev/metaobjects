package com.metaobjects.smoke;

import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;

import java.net.URI;
import java.util.List;

/**
 * Spring Boot fat-jar bootstrap smoke test — run via {@code java -jar} from a
 * jar repackaged by {@code spring-boot-maven-plugin}.
 *
 * <p>In a Spring Boot fat jar the {@code MetaDataTypeProvider} service manifests
 * ({@code META-INF/services/...}) live inside nested {@code BOOT-INF/lib/*.jar}
 * entries that only the {@code LaunchedClassLoader} can enumerate. The runtime
 * loader failed when the type registry's ServiceLoader bootstrap ran against a
 * classloader blind to those nested manifests: zero providers were discovered,
 * so {@code metadata -> root} was never designated and a bare {@code metadata:}
 * YAML root failed to desugar.</p>
 *
 * <p>This smoke FORCES that adverse condition — it makes the system classloader
 * (which, in a fat jar, cannot see nested {@code BOOT-INF/lib} resources) the
 * thread-context loader before the first registry access — then loads a bundled
 * bare-{@code metadata:} model. Pre-fix this prints {@code FATJAR_SMOKE_FAIL}
 * (no default subType); post-fix the registry discovers providers via additional
 * classloaders at discovery time and the load succeeds with
 * {@code FATJAR_SMOKE_OK}. It exercises all three parts of the fix: provider
 * discovery, {@code model:resource:} resolution, and the default-subType
 * designation.</p>
 */
public final class FatJarSmoke {

    private FatJarSmoke() {
    }

    public static void main(String[] args) {
        // Force the adverse fat-jar condition: the system classloader cannot
        // enumerate META-INF/services (or resources) in nested BOOT-INF/lib jars.
        // Making it the thread-context loader means the registry's ServiceLoader
        // bootstrap captures a loader blind to the providers — exactly the
        // runtime failure observed in a packaged Spring Boot application.
        Thread.currentThread().setContextClassLoader(ClassLoader.getSystemClassLoader());

        try {
            MetaDataLoader loader = MetaDataLoader.fromUris(
                "fatjar-smoke",
                List.of(URI.create("model:resource:meta.smoke.yaml")),
                LoaderOptions.create(false, false, true));

            // Reaching here means the bare `metadata:` root desugared to
            // metadata.root and the bundled model loaded.
            int children = loader.getChildren().size();
            System.out.println("FATJAR_SMOKE_OK loaded '" + loader.getName()
                + "' with " + children + " top-level child(ren)");
            System.exit(0);
        } catch (Throwable t) {
            System.out.println("FATJAR_SMOKE_FAIL " + t.getClass().getName() + ": " + t.getMessage());
            t.printStackTrace(System.out);
            System.exit(1);
        }
    }
}
