package com.metaobjects.generator.spring;

import com.metaobjects.generator.writer.JavaWriter;
import com.metaobjects.generator.writer.WriterOptions;

/**
 * The {@link JavaWriter} the Spring generators write through, with the two layouts Spring
 * source uses that a block does not express: a CONTINUATION line (a wrapped signature or call
 * chain, two indents deeper than the statement it continues) and an indented run that opens no
 * block (a {@code case} body).
 *
 * <p>Public and subclassable, like the writer it extends (ADR-0063): an owned generator that
 * wants a different continuation indent overrides {@link #continuationLevels()}.</p>
 */
public class SpringJavaWriter extends JavaWriter {

    /** The opener text recorded for an indent that opens no block. */
    protected static final String NO_BLOCK = "";

    public SpringJavaWriter() {
        super();
    }

    public SpringJavaWriter(WriterOptions options) {
        super(options);
    }

    /** How many indents a continuation line sits below the statement it continues: two. */
    protected int continuationLevels() {
        return 2;
    }

    /** Run {@code body} {@code levels} indents deeper, opening no block and closing none. */
    public SpringJavaWriter deeper(int levels, Runnable body) {
        for (int i = 0; i < levels; i++) openers.add(NO_BLOCK);
        try {
            body.run();
        } finally {
            for (int i = 0; i < levels; i++) openers.remove(openers.size() - 1);
        }
        return this;
    }

    /** One line continuing the statement or signature above it. */
    public SpringJavaWriter continuation(Object... parts) {
        return deeper(continuationLevels(), () -> line(parts));
    }

    /**
     * The body of a block whose opening line was already written, as the last continuation
     * line of a wrapped signature: indents one level from the current one and closes with
     * {@code }} when the returned scope closes.
     */
    public Block bodyBlock() {
        // An empty head writes no line (it is a blank-line request, and none is written at the
        // start of a block), so this only opens the indent.
        return block(NO_BLOCK);
    }
}
