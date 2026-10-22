package acme.shipping;

import jakarta.validation.constraints.*;
import com.fasterxml.jackson.annotation.JsonInclude;

/** GENERATED — value object ShipmentNote. Do not hand-edit; regenerated from metadata. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ShipmentNote(
    @NotNull @Size(min = 1) String text,
    ShipmentNoteKind kind,
    @NotNull Status status,
    @NotNull Status stage
) {
    public enum ShipmentNoteKind { INFO, ALERT }
    public enum Status { PENDING, SHIPPED, DELIVERED }

    /** A fluent builder, so a caller can set a subset of the components. */
    public static Builder builder() { return new Builder(); }

    /** Builds a {@link ShipmentNote}; an unset component stays null. */
    public static final class Builder {
        private String text;
        private ShipmentNoteKind kind;
        private Status status;
        private Status stage;

        private Builder() {}

        public Builder text(String v) { this.text = v; return this; }
        public Builder kind(ShipmentNoteKind v) { this.kind = v; return this; }
        public Builder status(Status v) { this.status = v; return this; }
        public Builder stage(Status v) { this.stage = v; return this; }

        public ShipmentNote build() { return new ShipmentNote(text, kind, status, stage); }
    }
}
