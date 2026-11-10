import test from "node:test";
import assert from "node:assert/strict";
import { normalizeState } from "../src/storage.js";
import type { QuotaState } from "../src/types.js";

const now = Date.UTC(2026, 0, 1, 0, 0, 0);
const dayMs = 24 * 60 * 60 * 1000;

function observation(updatedAt: number): QuotaState["observations"][string] {
	return {
		provider: "anthropic",
		model: "claude-sonnet-4",
		source: "subscription",
		observedAt: updatedAt,
		updatedAt,
		dimensions: [],
	};
}

test("state pruning drops observations last updated more than 30 days ago", () => {
	const pruned = normalizeState(
		{
			version: 1,
			observations: {
				"anthropic/claude-sonnet-4": observation(now - 40 * dayMs),
				"anthropic/claude-opus-4": observation(now - 40 * dayMs),
				"openai-codex/gpt-5.5": observation(now - 29 * dayMs),
			},
		},
		now,
	);
	assert.deepEqual(Object.keys(pruned.observations), ["openai-codex/gpt-5.5"]);
});

test("state pruning keeps a fallback observation until its window closes", () => {
	const fallbackObservation = (updatedAt: number, resetAt: number) => ({
		provider: "anthropic",
		model: "claude-sonnet-4",
		source: "fallback",
		observedAt: updatedAt,
		updatedAt,
		dimensions: [
			{ name: "messages", limit: 45, remaining: 40, resetAt, observedAt: updatedAt, source: "fallback" },
		],
	});
	const pruned = normalizeState(
		{
			version: 1,
			observations: {
				"anthropic/claude-sonnet-4": fallbackObservation(now - 40 * dayMs, now + 2 * dayMs),
			},
		},
		now,
	);
	assert.deepEqual(Object.keys(pruned.observations), ["anthropic/claude-sonnet-4"]);

	const closed = normalizeState(
		{
			version: 1,
			observations: {
				"anthropic/claude-sonnet-4": fallbackObservation(now - 40 * dayMs, now - 2 * dayMs),
			},
		},
		now,
	);
	assert.deepEqual(Object.keys(closed.observations), []);
});

test("state pruning drops pending observations older than a day", () => {
	const pending = {
		observation: observation(now),
		reason: "high-to-low same-window Codex 5h quota drop",
		createdAt: now - 25 * 60 * 60 * 1000,
		updatedAt: now,
	};
	const pruned = normalizeState({ version: 1, observations: {}, pendingObservations: { "openai-codex/gpt-5.5": pending } }, now);
	assert.equal(pruned.pendingObservations, undefined);
});

test("state pruning is idempotent under repeated normalization", () => {
	const input = {
		version: 1,
		observations: {
			"anthropic/claude-sonnet-4": observation(now - 40 * dayMs),
		},
	};
	const first = normalizeState(input, now);
	const second = normalizeState(first, now);
	assert.deepEqual(second, first);
	assert.deepEqual(Object.keys(second.observations), []);
});

test("state loading discards malformed observations while preserving valid data", () => {
	const valid: QuotaState["observations"][string] = {
		...observation(now),
		adapter: "subscription",
		status: 200,
		dimensions: [{ name: "5h", limit: 100, remaining: 80, resetAt: now + dayMs, observedAt: now, source: "subscription" }],
		metrics: [{ name: "balance", value: 10, unit: "USD", observedAt: now, source: "provider" }],
		metadata: {
			accountHeaderSent: true,
			allowed: true,
			limitReached: false,
			rateLimitReachedType: null,
			codexCliRpcFallback: true,
			extraLimits: [{ name: "extra", usedPercent: 20, remaining: 80, resetAt: now + dayMs }],
		},
	};
	const state = normalizeState(
		{
			observations: {
				valid,
				null: null,
				missingDimensions: { ...valid, dimensions: undefined },
				invalidDimension: { ...valid, dimensions: [null] },
				invalidNumber: {
					...valid,
					dimensions: [
						{
							name: "5h",
							remaining: "80",
							observedAt: now,
							source: "subscription",
						},
					],
				},
				invalidMetric: {
					...valid,
					metrics: [{ name: "balance", value: 10, unit: null }],
				},
				invalidMetadata: { ...valid, metadata: { extraLimits: [null] } },
				invalidFallback: { ...valid, source: "fallback", dimensions: {} },
			},
		},
		now,
	);
	assert.deepEqual(state.observations, { valid });
});

test("state loading rejects malformed pending confirmations", () => {
	const valid = {
		observation: observation(now),
		reason: "drop",
		createdAt: now,
		updatedAt: now,
	};
	const state = normalizeState(
		{
			observations: {},
			pendingObservations: {
				valid,
				missingObservation: { createdAt: now },
				invalidObservation: { ...valid, observation: { updatedAt: now } },
				invalidNumber: { ...valid, priorRemaining: "99" },
			},
		},
		now,
	);
	assert.deepEqual(state.pendingObservations, { valid });
});
