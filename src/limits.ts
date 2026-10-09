import type { Completion, Config, PriceSnapshot } from './contracts.js';
import { AppError } from './errors.js';

export type LimitState = {
  attempts: number;
  reservedMicrousd: number;
  settledMicrousd: number;
  uncertain: boolean;
};

function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(4, `${name} must be a nonnegative safe integer`);
  }
  return value;
}

function validateState(state: LimitState): void {
  integer(state.attempts, 'Attempts');
  integer(state.reservedMicrousd, 'Reserved cost');
  integer(state.settledMicrousd, 'Settled cost');
  integer(state.reservedMicrousd + state.settledMicrousd, 'Total cost');
}

export function reserve(
  state: LimitState,
  limits: Config['limits'],
  price: PriceSnapshot | null,
): { next: LimitState; reservationMicrousd: number } {
  validateState(state);
  integer(limits.maxCalls, 'Call limit');
  if (state.attempts >= limits.maxCalls) throw new AppError(4, 'Call limit reached');
  let reservationMicrousd = 0;
  if (limits.maxEstimatedCostMicrousd !== null) {
    const maximum = integer(limits.maxEstimatedCostMicrousd, 'Estimated cost limit');
    if (state.uncertain) throw new AppError(4, 'Previous call cost is unknown');
    if (!price) throw new AppError(4, 'A usable price snapshot is required');
    integer(price.contextWindow, 'Context window');
    integer(limits.maxOutputTokens, 'Output token limit');
    integer(price.inputPerMillionMicrousd, 'Input price');
    integer(price.outputPerMillionMicrousd, 'Output price');
    const input = integer(price.contextWindow * price.inputPerMillionMicrousd, 'Input reservation product');
    const output = integer(limits.maxOutputTokens * price.outputPerMillionMicrousd, 'Output reservation product');
    const total = integer(input + output, 'Reservation numerator');
    // Avoid adding a rounding offset that could overflow a safe numerator.
    reservationMicrousd = Math.floor(total / 1_000_000) + (total % 1_000_000 === 0 ? 0 : 1);
    if (state.settledMicrousd + state.reservedMicrousd > maximum - reservationMicrousd) {
      throw new AppError(4, 'Insufficient estimated cost budget');
    }
  }
  return {
    next: {
      ...state,
      attempts: integer(state.attempts + 1, 'Attempts'),
      reservedMicrousd: integer(state.reservedMicrousd + reservationMicrousd, 'Reserved cost'),
    },
    reservationMicrousd,
  };
}

export function settle(
  state: LimitState,
  reservationMicrousd: number,
  completion: Completion,
): LimitState {
  validateState(state);
  integer(reservationMicrousd, 'Reservation');
  if (reservationMicrousd > state.reservedMicrousd) {
    throw new AppError(4, 'Reservation exceeds outstanding reserved cost');
  }
  const { inputTokens, outputTokens, estimatedCostMicrousd } = completion.usage;
  for (const value of [inputTokens, outputTokens, estimatedCostMicrousd]) {
    if (value !== null) integer(value, 'Actual usage');
  }
  if (inputTokens === null || outputTokens === null || estimatedCostMicrousd === null) {
    return { ...state, uncertain: true };
  }
  const next = {
    ...state,
    reservedMicrousd: state.reservedMicrousd - reservationMicrousd,
    settledMicrousd: integer(state.settledMicrousd + estimatedCostMicrousd, 'Settled cost'),
  };
  validateState(next);
  return next;
}

/** Rebuild charges from starts and response usage, including store-repaired finishes.
 * Missing responses retain their original conservative reservation. Their amount
 * remains unknown in diagnostics; explicit retry never releases that reservation.
 */
export function reconstructLimits(record: import('./contracts.js').RunRecord, completions?: Map<string, Completion>): LimitState {
  const starts = record.events.filter(event => event.type === 'call_started').map(event => event.payload as { callId: string; reservationMicrousd?: number });
  let state: LimitState = { attempts: starts.length, reservedMicrousd: 0, settledMicrousd: 0, uncertain: false };
  for (const start of starts) state.reservedMicrousd = integer(state.reservedMicrousd + integer(start.reservationMicrousd ?? 0, 'Reservation'), 'Reserved cost');
  for (const start of starts) {
    const usage = (record.events.find(event => event.type === 'call_finished' && (event.payload as {callId?:string}).callId === start.callId)?.payload as {usage?: Completion['usage']} | undefined)?.usage;
    const completion = completions?.get(start.callId) ?? (usage ? {text:'', stopReason:'stop' as const, usage, raw:null} : undefined);
    if (completion) state = settle(state, start.reservationMicrousd ?? 0, completion);
  }
  return state;
}
