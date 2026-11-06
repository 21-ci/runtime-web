// The fetch and wall budget of one tick. Lives apart from the runner so that feature code can tell
// "the tick ran out" from "the call failed" without importing the runner.

export class BudgetExhausted extends Error {
  readonly code = "budget_exhausted";
  constructor() {
    super("budget_exhausted");
    this.name = "BudgetExhausted";
  }
}

/**
 * For catch blocks that turn a failure into retry state (attempts, TXT misses): running out of budget
 * says nothing about the remote side, so it must pass through instead of being charged to the row.
 */
export function rethrowBudget(e: unknown): void {
  if (e instanceof BudgetExhausted) throw e;
}
