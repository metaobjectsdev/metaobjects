package acme.shipping;

import jakarta.validation.constraints.*;

/** GENERATED — wire DTO for Parcel. Do not hand-edit; regenerated from metadata. */
public record ParcelDto(
    @NotNull Long id,
    @NotNull Status phase
) {
    public enum Status { PENDING, SHIPPED, DELIVERED }

    /** A fluent builder, so a caller can set a subset of the components. */
    public static Builder builder() { return new Builder(); }

    /** Builds a {@link ParcelDto}; an unset component stays null. */
    public static final class Builder {
        private Long id;
        private Status phase;

        private Builder() {}

        public Builder id(Long v) { this.id = v; return this; }
        public Builder phase(Status v) { this.phase = v; return this; }

        public ParcelDto build() { return new ParcelDto(id, phase); }
    }
}
