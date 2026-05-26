// Loading the Angular JIT compiler so Angular core can resolve its
// ɵɵngDeclare* declarations at runtime (needed because the linker hasn't run
// in the bun test process). Has the side effect of registering the JIT
// compiler factory on the global Angular module.
import "@angular/compiler";
