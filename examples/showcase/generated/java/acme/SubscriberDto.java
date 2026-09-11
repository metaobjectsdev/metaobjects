package acme;

import jakarta.validation.constraints.*;

/** GENERATED — wire DTO for Subscriber. Do not hand-edit; regenerated from metadata. */
public record SubscriberDto(
    Long id,
    @NotNull @Size(min = 1, max = 320) String email,
    String name,
    @NotNull SubscriberStatus status,
    java.time.Instant createdAt
) {
    public enum SubscriberStatus { active, paused, cancelled }

    /** Issue #203 @autoSet: a copy with every @autoSet column (onCreate AND onUpdate) stamped to now() on insert (the model value is ignored; a fresh row's updated_at equals its created_at). */
    public static SubscriberDto stampForInsert(SubscriberDto dto) {
        java.time.Instant __nowInstant = java.time.Instant.now();
        return new SubscriberDto(
            dto.id(),
            dto.email(),
            dto.name(),
            dto.status(),
            __nowInstant
        );
    }

    /** Issue #203 @autoSet: a copy with @autoSet onUpdate columns stamped to now(); onCreate columns are preserved (never rewrites created_at — the full-DTO update path). */
    public static SubscriberDto stampForUpdate(SubscriberDto dto) {
        return new SubscriberDto(
            dto.id(),
            dto.email(),
            dto.name(),
            dto.status(),
            dto.createdAt()
        );
    }

    /** Issue #203 @autoSet escape hatch: the DTO written VERBATIM (import/restore/replication). */
    public static SubscriberDto insertPreserving(SubscriberDto dto) { return dto; }

    /** A fluent builder, so a caller can set a subset of the components. */
    public static Builder builder() { return new Builder(); }

    /** Builds a {@link SubscriberDto}; an unset component stays null. */
    public static final class Builder {
        private Long id;
        private String email;
        private String name;
        private SubscriberStatus status;
        private java.time.Instant createdAt;

        private Builder() {}

        public Builder id(Long v) { this.id = v; return this; }
        public Builder email(String v) { this.email = v; return this; }
        public Builder name(String v) { this.name = v; return this; }
        public Builder status(SubscriberStatus v) { this.status = v; return this; }
        public Builder createdAt(java.time.Instant v) { this.createdAt = v; return this; }

        public SubscriberDto build() { return new SubscriberDto(id, email, name, status, createdAt); }
    }
}
