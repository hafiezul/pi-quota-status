import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.js";
import { adapterMatches, matchesGlob, selectAdapter } from "../src/match.js";
import {
	buildQuotaRows,
	observationFromParsed,
	consumeFallbackQuota,
	ensureFallbackObservation,
	selectQuotaForModel,
	upsertObservation,
} from "../src/quota.js";
import type { QuotaState, QuotaStatusConfig } from "../src/types.js";

const now = Date.UTC(2026, 0, 1, 0, 0, 0);

test("glob matching supports provider plus model globs", () => {
	assert.equal(matchesGlob("claude-sonnet-4", "claude-*"), true);
	assert.equal(matchesGlob("gpt-4.1", "claude-*"), false);
	assert.equal(
		adapterMatches(
			{ provider: "anthropic", models: ["claude-?"] },
			"anthropic",
			"claude-x",
		),
		true,
	);
});

test("selectAdapter returns first matching enabled adapter", () => {
	const config = normalizeConfig({
		adapters: [
			{
				name: "disabled",
				enabled: false,
				provider: "anthropic",
				models: ["*"],
			},
			{ name: "match", provider: "anthropic", models: ["claude-*"] },
		],
	});
	assert.equal(
		selectAdapter(config, "anthropic", "claude-sonnet-4")?.name,
		"match",
	);
});

test("selectQuotaForModel uses the most constrained dimension", () => {
	const config: QuotaStatusConfig = normalizeConfig({
		adapters: [
			{ name: "generic", provider: "anthropic", models: ["claude-*"] },
		],
	});
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "anthropic", model: "claude-sonnet-4" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "generic" },
			{
				dimensions: [
					{ name: "requests", limit: 100, remaining: 72 },
					{ name: "tokens", limit: 1000, remaining: 80 },
				],
			},
			"headers",
			200,
			now,
		),
	);
	const selected = selectQuotaForModel(state, config, ref, now);
	assert.equal(selected?.dimension.name, "tokens");
	assert.equal(selected?.percentRemaining, 8);
});

test("fallback initializes and deducts fixed-window turns", () => {
	const config: QuotaStatusConfig = normalizeConfig({
		adapters: [
			{
				name: "fallback",
				provider: "anthropic",
				models: ["claude-*"],
				fallback: {
					enabled: true,
					dimension: "messages",
					limit: 5,
					windowSeconds: 3600,
					consume: { unit: "turns", amount: 1 },
				},
			},
		],
	});
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "anthropic", model: "claude-sonnet-4" };
	ensureFallbackObservation(state, config, ref, now);
	assert.equal(
		selectQuotaForModel(state, config, ref, now)?.percentRemaining,
		100,
	);
	consumeFallbackQuota(state, config, ref, now + 1000);
	assert.equal(
		selectQuotaForModel(state, config, ref, now + 1000)?.dimension.remaining,
		4,
	);
});

test("fallback rows are not synthesized for unobserved models", () => {
	const config: QuotaStatusConfig = normalizeConfig({
		adapters: [
			{
				name: "fallback",
				provider: "openai*",
				models: ["gpt-*"],
				fallback: {
					enabled: true,
					dimension: "subscription",
					limit: 5,
					windowSeconds: 3600,
				},
			},
		],
	});
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "openai", model: "gpt-5.5" };

	assert.equal(selectQuotaForModel(state, config, ref, now), undefined);
	assert.deepEqual(
		buildQuotaRows(
			config,
			state,
			[{ provider: "openai", id: "gpt-5.5" }],
			now,
		),
		[],
	);
});

test("fallback recomputes after reset window passes", () => {
	const config: QuotaStatusConfig = normalizeConfig({
		adapters: [
			{
				name: "fallback",
				provider: "anthropic",
				models: ["claude-*"],
				fallback: {
					enabled: true,
					dimension: "messages",
					limit: 5,
					windowSeconds: 60,
				},
			},
		],
	});
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "anthropic", model: "claude-sonnet-4" };
	consumeFallbackQuota(state, config, ref, now);
	const later = selectQuotaForModel(state, config, ref, now + 61_000);
	assert.equal(later?.dimension.remaining, 5);
	assert.equal(later?.percentRemaining, 100);
});
