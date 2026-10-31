package com.metaobjects.integration;

import org.testcontainers.DockerClientFactory;
import org.testcontainers.utility.ResourceReaper;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

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
 */
final class ReaperLabels {
    private static List<String> labelArgs;

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
}
