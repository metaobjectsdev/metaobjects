package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.MigrationSqlRenderer;

/** Assembles the forward-only {@code up} script from allowed changes; refuses if any change is blocked. */
public final class MigrationEmitter {
    private final MigrationSqlRenderer renderer;

    public MigrationEmitter(MigrationSqlRenderer renderer) {
        this.renderer = renderer;
    }

    public EmitResult emit(DiffResult diff) {
        if (!diff.blocked().isEmpty()) throw new BlockedChangesError(diff.blocked());
        StringBuilder up = new StringBuilder();
        for (Change c : diff.changes()) up.append(renderer.render(c)).append(";\n");
        return new EmitResult(up.toString(), "");   // forward-only v1
    }
}
