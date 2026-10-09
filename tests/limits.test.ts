import { describe, expect, it, vi } from 'vitest';
import type { Completion, PriceSnapshot } from '../src/contracts.js';
import { reserve, settle, type LimitState } from '../src/limits.js';
import { config } from './fixtures.js';

const initial: LimitState = { attempts: 0, reservedMicrousd: 0, settledMicrousd: 0, uncertain: false };
const price: PriceSnapshot = {
  provider: 'openai', model: 'writer', inputPerMillionMicrousd: 1_000_000,
  outputPerMillionMicrousd: 2_000_000, contextWindow: 100,
  observedAt: '2026-10-09T00:00:00Z', source: 'test',
};
const limits = { ...config.limits, maxCalls: 2, maxOutputTokens: 10, maxEstimatedCostMicrousd: 240 };
const completion = (cost: number | null, input: number | null = 1): Completion => ({
  text: '', stopReason: 'stop', usage: { inputTokens: input, outputTokens: 1, estimatedCostMicrousd: cost }, raw: {},
});

describe('call and estimated cost limits', () => {
  it('refuses the third dispatch without invoking the downstream client', () => {
    const dispatch = vi.fn();
    let state = initial;
    const attempt = () => {
      state = reserve(state, { ...limits, maxEstimatedCostMicrousd: null }, null).next;
      dispatch();
    };
    attempt();
    attempt();
    expect(attempt).toThrow();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(state.attempts).toBe(2);
  });
  it('requires a quote only when a finite fee limit is enabled', () => {
    expect(() => reserve(initial, limits, null)).toThrow();
    expect(reserve(initial, { ...limits, maxEstimatedCostMicrousd: null }, null)).toEqual({
      next: { ...initial, attempts: 1 }, reservationMicrousd: 0,
    });
  });
  it('permits an equal balance and rejects one microdollar less', () => {
    expect(reserve(initial, { ...limits, maxEstimatedCostMicrousd: 120 }, price).reservationMicrousd).toBe(120);
    expect(() => reserve(initial, { ...limits, maxEstimatedCostMicrousd: 119 }, price)).toThrow();
  });
  it('rounds up fractional reservations', () => {
    expect(reserve(initial, limits, { ...price, inputPerMillionMicrousd: 1, outputPerMillionMicrousd: 1 }).reservationMicrousd).toBe(1);
  });
  it('retains reservations and marks unknown usage without mutating state', () => {
    const reserved = reserve(initial, limits, price);
    const next = settle(reserved.next, reserved.reservationMicrousd, completion(null));
    expect(next).toEqual({ attempts: 1, reservedMicrousd: 120, settledMicrousd: 0, uncertain: true });
    expect(reserved.next.uncertain).toBe(false);
    expect(initial.attempts).toBe(0);
    expect(() => reserve(next, limits, price)).toThrow();
  });
  it('tracks unknown usage with unlimited fees and continues until the call cap', () => {
    const unlimited = { ...limits, maxEstimatedCostMicrousd: null };
    const next = settle(reserve(initial, unlimited, null).next, 0, completion(null));
    expect(next.uncertain).toBe(true);
    const second = reserve(next, unlimited, null).next;
    expect(() => reserve(second, unlimited, null)).toThrow();
    expect(settle(second, 0, completion(5)).uncertain).toBe(true);
  });
  it('treats missing token usage as unknown even when a cost was supplied', () => {
    expect(settle(reserve(initial, limits, price).next, 120, completion(0, null)).uncertain).toBe(true);
  });
  it('settles known costs and does not refund failed attempts', () => {
    const reserved = reserve(initial, limits, price);
    const failed = { ...completion(25), stopReason: 'error' as const };
    expect(settle(reserved.next, 120, failed)).toEqual({ attempts: 1, reservedMicrousd: 0, settledMicrousd: 25, uncertain: false });
  });
  it('preserves actual costs above reservation and refuses the next dispatch', () => {
    const next = settle(reserve(initial, limits, price).next, 120, completion(241));
    expect(next.settledMicrousd).toBe(241);
    expect(() => reserve(next, limits, price)).toThrow();
  });
  it('rejects unsafe prices, products, sums, and negative settlement', () => {
    expect(() => reserve(initial, limits, { ...price, contextWindow: Number.MAX_SAFE_INTEGER })).toThrow();
    expect(() => reserve(initial, limits, { ...price, inputPerMillionMicrousd: -1 })).toThrow();
    expect(() => reserve({ ...initial, settledMicrousd: Number.MAX_SAFE_INTEGER }, limits, price)).toThrow();
    expect(() => settle({ ...initial, reservedMicrousd: 120 }, 120, completion(-1))).toThrow();
    expect(() => settle({ ...initial, settledMicrousd: Number.MAX_SAFE_INTEGER }, 0, completion(1))).toThrow();
    expect(() => settle(initial, 1, completion(0))).toThrow();
  });
});
