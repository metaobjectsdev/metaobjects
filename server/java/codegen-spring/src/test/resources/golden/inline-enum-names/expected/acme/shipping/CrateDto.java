package acme.shipping;

import jakarta.validation.constraints.*;

/** GENERATED — wire DTO for Crate. Do not hand-edit; regenerated from metadata. */
public record CrateDto(
    @NotNull Long id,
    @NotNull Status stage
) {
    public enum Status { PENDING, SHIPPED, DELIVERED }

    /** A fluent builder, so a caller can set a subset of the components. */
    public static Builder builder() { return new Builder(); }

    /** Builds a {@link CrateDto}; an unset component stays null. */
    public static final class Builder {
        private Long id;
        private Status stage;

        private Builder() {}

        public Builder id(Long v) { this.id = v; return this; }
        public Builder stage(Status v) { this.stage = v; return this; }

        public CrateDto build() { return new CrateDto(id, stage); }
    }
}
