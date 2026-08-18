package com.metaobjects.generator.util;

import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * The marker floor: codegen-concepts §7's "the generator will not silently eat your work",
 * which these ports were not implementing at all.
 */
public class GeneratedFileWriterTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String GENERATED_BODY =
        "/** GENERATED — REST controller for Council. */\npublic class X {}\n";

    @Test
    public void writesWhenThePathIsNew() throws Exception {
        Path out = tmp.getRoot().toPath().resolve("nested/dir/X.java");

        assertEquals(GeneratedFileWriter.Outcome.WRITTEN,
            GeneratedFileWriter.write(out, GENERATED_BODY));
        assertEquals(GENERATED_BODY, Files.readString(out));
    }

    @Test
    public void overwritesItsOwnOutput() throws Exception {
        Path out = tmp.getRoot().toPath().resolve("X.java");
        GeneratedFileWriter.write(out, GENERATED_BODY);

        String fresh = "/** GENERATED — REST controller for Council. */\npublic class X { int y; }\n";
        assertEquals(GeneratedFileWriter.Outcome.WRITTEN,
            GeneratedFileWriter.write(out, fresh));
        assertEquals(fresh, Files.readString(out));
    }

    @Test
    public void refusesAFileWithNoMarker_andLeavesItExactlyAsFound() throws Exception {
        // The defect this closes: before the guard, this file was overwritten silently.
        Path out = tmp.getRoot().toPath().resolve("X.java");
        String mine = "// my own controller, written by hand\npublic class X {}\n";
        Files.writeString(out, mine);

        assertEquals(GeneratedFileWriter.Outcome.REFUSED,
            GeneratedFileWriter.write(out, GENERATED_BODY));
        assertEquals(mine, Files.readString(out));
    }

    @Test
    public void deletingTheMarkerIsHowYouTakeOwnership() throws Exception {
        // The documented gesture, exercised end to end: generate, strip the marker,
        // regenerate, and the file is now permanently yours.
        Path out = tmp.getRoot().toPath().resolve("X.java");
        GeneratedFileWriter.write(out, GENERATED_BODY);

        String owned = GENERATED_BODY.replace("GENERATED", "hand-owned") + "// mine now\n";
        Files.writeString(out, owned);

        assertEquals(GeneratedFileWriter.Outcome.REFUSED,
            GeneratedFileWriter.write(out, GENERATED_BODY));
        assertEquals(owned, Files.readString(out));
    }

    @Test
    public void theMarkerIsMatchedAnywhere_notOnlyInOnePhrasing() throws Exception {
        // Generators word their headers differently ("/** GENERATED — …",
        // "// GENERATED — DO NOT EDIT — …"). A guard tied to one exact phrasing would
        // fail OPEN on the others, which is the failure mode being removed.
        Path out = tmp.getRoot().toPath().resolve("X.kt");
        Files.writeString(out, "// GENERATED — DO NOT EDIT — output-format prompt\nval x = 1\n");

        assertEquals(GeneratedFileWriter.Outcome.WRITTEN,
            GeneratedFileWriter.write(out, "// GENERATED — DO NOT EDIT — v2\nval x = 2\n"));
    }

    @Test
    public void aHandWrittenFileMerelyMentioningTheWordIsNotOurs() throws Exception {
        // The guard's own fail-open: a bare substring match treated any file containing
        // the word as generator output and clobbered it — the silent overwrite this
        // class exists to prevent, produced by the class itself. These are the shapes
        // that actually occur in hand-written source.
        for (String mine : new String[] {
                "// NOT GENERATED - hand-maintained, see the ADR\npublic class X {}\n",
                "public enum Kind { GENERATED, MANUAL }\n",
                "/** Explains why the GENERATED files are disposable. */\npublic class X {}\n",
        }) {
            Path out = tmp.newFolder().toPath().resolve("X.java");
            Files.writeString(out, mine);
            assertEquals(mine, GeneratedFileWriter.Outcome.REFUSED,
                    GeneratedFileWriter.write(out, GENERATED_BODY));
            assertEquals(mine, Files.readString(out));
        }
    }

    @Test
    public void everyGeneratorsRealHeaderShapeIsStillRecognised() throws Exception {
        // The tolerance that matters: prose after the token varies per generator, so
        // narrowing the match must not start refusing our OWN output.
        for (String header : new String[] {
                "/** GENERATED - wire DTO for Council. */\npublic class X {}\n",
                " * GENERATED - runtime drift gate.\n",
                "// GENERATED - DO NOT EDIT - output-format prompt\n",
                "/** GENERATED (#234) - strict Jackson deserializers. */\n",
        }) {
            Path out = tmp.newFolder().toPath().resolve("X.java");
            Files.writeString(out, header);
            assertEquals(header, GeneratedFileWriter.Outcome.WRITTEN,
                    GeneratedFileWriter.write(out, GENERATED_BODY));
        }
    }

    @Test
    public void theRefusalNamesTheFileAndTheWayOut() {
        Path out = tmp.getRoot().toPath().resolve("X.java");
        String msg = GeneratedFileWriter.refusedMessage(out);

        assertTrue(msg.contains("X.java"));
        assertTrue(msg.contains("GENERATED"));
        // An unexplained refusal gets the file deleted by hand — the outcome refusing
        // exists to prevent — so the message must say how to get the generated version.
        assertTrue(msg.contains("delete"));
    }
}
