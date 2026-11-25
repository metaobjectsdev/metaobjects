- **codegen-ts-angular: the generated form binds its controls.** Each control in
  `<Entity>.form.component.ts` read `[formControlName]=""email""`, a binding whose quoted
  expression was cut short by the attribute's own quotes, so Angular bound no control. It now
  writes `formControlName="email"`. The form also imports `Validators` only when a control uses
  it, and the `__ensureValidatorsImport__` line that kept the import alive is gone. The TanStack
  and Angular templates now write through the code writer (ADR-0063). Their output is otherwise
  the same code, with imports merged per module and sorted.
