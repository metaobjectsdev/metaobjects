package com.metaobjects.integration;

import org.testcontainers.DockerClientFactory;
import org.testcontainers.utility.ResourceReaper;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Puts a {@code docker} CLI test container under Ryuk, the Testcontainers reaper.
 *
 * <p>{@code close()} and an {@code @AfterAll} cannot run in a killed JVM: SIGKILL, the kernel OOM
 * killer and earlyoom all skip them, and SIGTERM runs shutdown hooks but no test teardown. Ryuk
 * closes that gap from outside the process. It runs in its own container and holds one TCP
 * connection per session. When that connection closes, for any reason, it waits ten seconds and
 * removes everything carrying all of the session's labels. The operating system closes the socket
 * of a killed process, so no code in the dying JVM has to run.
 *
 * <p>Each JVM gets its own session, so one fork's death reaps that fork's containers and no other
 * run's. {@code TESTCONTAINERS_RYUK_DISABLED=true} turns the reaper off.
 *
 * <p>{@link #removeAtExit} covers what Ryuk does not: a run with Ryuk disabled, and a SIGTERM, which
 * runs shutdown hooks. {@link #ramVolume} keeps a database's data directory in RAM: an image's
 * {@code VOLUME} with no mount becomes an anonymous volume on disk.
 */
final class ReaperLabels {
    /** Upper bound for one database's data directory; tmpfs takes RAM only for what is written. */
    static final String TMPFS_SIZE = "2g";
    /** {@code postgres} server options for a database whose contents may be lost at any moment. */
    static final List<String> POSTGRES_DURABILITY_OFF = List.of(
        "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off");

    private static List<String> labelArgs;
    private static final Set<String> started = ConcurrentHashMap.newKeySet();
    private static boolean shutdownHookInstalled;

    private ReaperLabels() {}

    /**
     * {@code docker run -d <labels> <rest>}. The first call starts Ryuk, and finishes before the
     * container starts, so a JVM killed at any later moment is covered.
     */
    static String[] dockerRun(String... rest) {
        List<String> args = new ArrayList<>(List.of("run", "-d"));
        args.addAll(labelArgs());
        args.addAll(List.of(rest));
        return args.toArray(String[]::new);
    }

    private static synchronized List<String> labelArgs() {
        if (labelArgs == null) {
            DockerClientFactory.instance().client();  // starts Ryuk and registers the session
            Map<String, String> labels = new TreeMap<>(DockerClientFactory.DEFAULT_LABELS);
            labels.putAll(ResourceReaper.instance().getLabels());
            List<String> args = new ArrayList<>();
            labels.forEach((key, value) -> args.addAll(List.of("--label", key + "=" + value)));
            labelArgs = args;
        }
        return labelArgs;
    }

    /** {@code docker run} flags mounting a size-capped tmpfs at {@code path}, the image's VOLUME. */
    static List<String> ramVolume(String path) {
        return List.of("--tmpfs", path + ":rw,size=" + TMPFS_SIZE);
    }

    /** Remove container {@code name} when the JVM shuts down, unless {@link #forget} says it is gone. */
    static synchronized void removeAtExit(String name) {
        started.add(name);
        if (!shutdownHookInstalled) {
            shutdownHookInstalled = true;
            Runtime.getRuntime().addShutdownHook(new Thread(ReaperLabels::removeAll, "remove-test-containers"));
        }
    }

    /** The launcher removed {@code name} itself. */
    static void forget(String name) {
        started.remove(name);
    }

    private static void removeAll() {
        for (String name : started) {
            try {
                new ProcessBuilder("docker", "rm", "-f", "-v", name)
                    .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start().waitFor(60, TimeUnit.SECONDS);
            } catch (Exception ignored) {
                // Best effort: Ryuk still removes a labelled container.
            }
        }
    }
}
