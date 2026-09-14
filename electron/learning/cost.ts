export interface CostReservationInput {
  jobId: string;
  provider: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
}

export type ReserveResult =
  | { kind: 'reserved'; reservationId: string }
  | { kind: 'denied'; reason: string };

export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface ReviewCostGate {
  reserve(input: CostReservationInput): Promise<ReserveResult>;
  settle(reservationId: string, usage: UsageReport | null): Promise<void>;
}

export const DEFAULT_MAX_INPUT_TOKENS = 8_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;
export const MAX_JOB_ATTEMPTS = 2;
export const LEASE_MS = 60_000;
