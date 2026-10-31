package com.metaobjects.integration;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A killed JVM removes its container.
 *
 * <p>Public behaviour: once a JVM that started a helper container dies without running any
 * teardown, Docker stops listing that container. The oracle is Docker itself, queried from outside
 * the killed JVM. A helper that labels nothing, or a reaper that accepts the label and removes
 * nothing, fails on the deadline.
 */
public final class ReaperKillTest {
    private static final Pattern READY = Pattern.compile("^READY (\\d+)$", Pattern.MULTILINE);
    private static final long CHILD_READY_MS = 60_000;
    // Ryuk waits 10s, then Docker has to finish the container's exit, and it cannot until the overlay
    // unmount has flushed the host filesystem's dirty pages. A busy disk makes removal slow, not wrong.
    // Measured with a 256 MiB backlog: 34-38s at 12 MB/s and 67-76s at 6 MB/s, against under 11s at
    // 6 MB/s with no backlog. Every removal succeeded.
    private static final long REMOVAL_BOUND_MS = 120_000;

    /** The killed JVM: it starts a real helper container, reports the port and waits. */
    public static void main(String[] args) throws Exception {
        PostgresContainer pg = new PostgresContainer();
        System.out.println("READY " + URI.create(pg.jdbcUrl().substring("jdbc:".length())).getPort());
        Thread.sleep(600_000);
    }

    @Test
    void killedJvmRemovesItsContainer() throws Exception {
        Path output = Files.createTempFile("reaper-child", ".log");
        ProcessBuilder builder = new ProcessBuilder(
            Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-cp", System.getProperty("java.class.path"), ReaperKillTest.class.getName())
            .redirectErrorStream(true)
            .redirectOutput(output.toFile());
        builder.environment().remove("METAOBJECTS_TEST_PG_URL");
        Process child = builder.start();
        String container = "";
        try {
            String port = awaitPort(child, output);
            container = docker("ps", "--filter", "publish=" + port + "/tcp", "--format", "{{.Names}}");
            assertFalse(container.isEmpty(), "no container publishes port " + port);

            child.destroyForcibly();
            assertTrue(child.waitFor(30, TimeUnit.SECONDS), "the child outlived SIGKILL");

            long deadline = System.currentTimeMillis() + REMOVAL_BOUND_MS;
            while (exists(container) && System.currentTimeMillis() < deadline) Thread.sleep(250);
            assertFalse(exists(container), container + " outlived its killed JVM (" + status(container) + ")");
        } finally {
            child.destroyForcibly();
            if (!container.isEmpty()) docker("rm", "-f", "-v", container);
            Files.deleteIfExists(output);
        }
    }

    private static String awaitPort(Process child, Path output) throws Exception {
        long deadline = System.currentTimeMillis() + CHILD_READY_MS;
        while (System.currentTimeMillis() < deadline && child.isAlive()) {
            Matcher ready = READY.matcher(Files.readString(output, StandardCharsets.UTF_8));
            if (ready.find()) return ready.group(1);
            Thread.sleep(250);
        }
        throw new AssertionError("reaper child never reported its container:\n" + Files.readString(output));
    }

    private static boolean exists(String container) throws IOException, InterruptedException {
        return !docker("ps", "-a", "--filter", "name=^" + container + "$", "--format", "{{.Names}}").isEmpty();
    }

    private static String status(String container) throws IOException, InterruptedException {
        return docker("ps", "-a", "--filter", "name=^" + container + "$", "--format", "{{.Status}}");
    }

    private static String docker(String... args) throws IOException, InterruptedException {
        String[] command = new String[args.length + 1];
        command[0] = "docker";
        System.arraycopy(args, 0, command, 1, args.length);
        Process p = new ProcessBuilder(command).redirectErrorStream(true).start();
        if (!p.waitFor(30, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new AssertionError("docker " + String.join(" ", args) + " did not finish");
        }
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        assertEquals(0, p.exitValue(), "docker " + String.join(" ", args) + ": " + out);
        return out;
    }
}
