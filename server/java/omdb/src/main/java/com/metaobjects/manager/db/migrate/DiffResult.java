package com.metaobjects.manager.db.migrate;

import java.util.List;

/** Port of migrate-ts DiffResult. `blocked` is the subset of `changes` with blocked status. */
public record DiffResult(List<Change> changes, List<Change> blocked) {
    public boolean isEmpty() { return changes.isEmpty(); }
}
