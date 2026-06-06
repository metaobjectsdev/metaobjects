package com.metaobjects.manager.db.ai;

import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectManagerDB;

import java.util.function.Consumer;

/**
 * {@link LlmCallRecorder} that persists trace rows via
 * {@link ObjectManagerDB#createObject(ObjectConnection, Object)}.
 *
 * <p>Java port of the TypeScript {@code LlmCallDbRecorder}. Like the TS reference,
 * persistence is <strong>never-throwing</strong>: a failed write is routed to an
 * injectable {@code onError} consumer (a no-op by default), so tracing can never
 * break the LLM call path.</p>
 *
 * <p>The caller owns the {@link ObjectConnection} lifecycle (acquisition,
 * transaction, release) and supplies it at construction — mirroring how OMDB
 * callers thread a connection through a unit of work.</p>
 */
public final class ObjectManagerDbLlmCallRecorder implements LlmCallRecorder {

    private final ObjectManagerDB omdb;
    private final ObjectConnection conn;
    private final Consumer<Throwable> onError;

    /**
     * @param omdb the OMDB instance to write through
     * @param conn the caller-owned connection to persist on
     */
    public ObjectManagerDbLlmCallRecorder(ObjectManagerDB omdb, ObjectConnection conn) {
        this(omdb, conn, t -> { /* default: swallow — tracing is non-blocking */ });
    }

    /**
     * @param omdb    the OMDB instance to write through
     * @param conn    the caller-owned connection to persist on
     * @param onError invoked (never re-thrown) when a write fails
     */
    public ObjectManagerDbLlmCallRecorder(ObjectManagerDB omdb, ObjectConnection conn,
                                          Consumer<Throwable> onError) {
        this.omdb = omdb;
        this.conn = conn;
        this.onError = onError;
    }

    @Override
    public void record(Object row) {
        try {
            omdb.createObject(conn, row);
        } catch (Throwable t) {
            onError.accept(t);
        }
    }
}
