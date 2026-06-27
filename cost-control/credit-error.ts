export type CreditExhaustedType = 'API_402' | 'BUDGET_DAILY' | 'BUDGET_SPRINT';

export class CreditExhaustedError extends Error {
  public readonly creditType: CreditExhaustedType;

  constructor(creditType: CreditExhaustedType, detail?: string) {
    super(`Credit exhausted [${creditType}]${detail ? ': ' + detail : ''}`);
    this.name = 'CreditExhaustedError';
    this.creditType = creditType;
  }
}
