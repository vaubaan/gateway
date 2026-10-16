/**
 * Errors of the budget module. None of them is a refusal: a refusal is data the
 * pipeline returns to the agent (`@vaubaan/gateway-core`'s `Refusal`); these are
 * thrown when an upstream invariant the pipeline guarantees does not hold, and the
 * transaction they interrupt rolls back.
 */

export class BudgetInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetInvariantError';
  }
}
