import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	ensureConfigTemplate,
	loadConfig,
	normalizeConfig,
} from "../src/config.js";
import { adapterMatches, matchesGlob, selectAdapter } from "../src/match.js";
import {
	applySubscriptionObservation,
	buildQuotaRows,
	observationFromParsed,
	consumeFallbackQuota,
	ensureFallbackObservation,
	selectFooterQuotaForModel,
	selectQuotaForModel,
	upsertObservation,
} from "../src/quota.js";
import type { QuotaState, QuotaStatusConfig } from "../src/types.js";

const now = Date.UTC(2026, 0, 1, 0, 0, 0);

async function createTempDir(): Promise<string> {
	const dir = [
		".tmp-quota-status-test",
		process.pid,
		Date.now(),
		Math.random().toString(16).slice(2),
	].join("-");
	await mkdir(dir, { recursive: true });
	return dir;
}

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

test("missing config defaults to Anthropic and OpenAI adapters", async () => {
	const dir = await createTempDir();
	try {
		const result = await loadConfig(join(dir, "missing-config.json"));
		assert.equal(
			selectAdapter(result.value, "anthropic", "claude-sonnet-4")?.name,
			"anthropic",
		);
		assert.equal(
			selectAdapter(result.value, "openai", "gpt-5.5")?.name,
			"openai",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("config template creates enabled Anthropic and OpenAI adapters", async () => {
	const dir = await createTempDir();
	const configFile = join(dir, "config.json");
	try {
		const result = await ensureConfigTemplate(configFile);
		assert.equal(result.created, true);
		assert.deepEqual(
			result.value.adapters?.map((adapter) => adapter.name),
			["anthropic", "openai"],
		);
		assert.equal(
			selectAdapter(result.value, "anthropic", "claude-sonnet-4")?.name,
			"anthropic",
		);
		assert.equal(
			selectAdapter(result.value, "openai", "gpt-5.5")?.name,
			"openai",
		);

		const written = JSON.parse(
			await readFile(configFile, "utf8"),
		) as QuotaStatusConfig;
		assert.equal(
			written.adapters?.find((adapter) => adapter.name === "anthropic")
				?.enabled,
			true,
		);
		assert.equal(
			written.adapters?.find((adapter) => adapter.name === "openai")?.enabled,
			true,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
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

test("subscription quota prefers the short reset window over weekly", () => {
	const config: QuotaStatusConfig = normalizeConfig({
		adapters: [{ name: "generic", provider: "openai-codex", models: ["*"] }],
	});
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "openai-codex", model: "gpt-5.5" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{
						name: "5h",
						limit: 100,
						remaining: 97,
						resetAt: now + 5 * 60 * 60 * 1000,
					},
					{
						name: "weekly",
						limit: 100,
						remaining: 49,
						resetAt: now + 5 * 24 * 60 * 60 * 1000,
					},
				],
			},
			"subscription",
			200,
			now,
		),
	);
	const selected = selectQuotaForModel(state, config, ref, now);
	assert.equal(selected?.dimension.name, "5h");
	assert.equal(selected?.percentRemaining, 97);
});

test("footer shows OpenAI Codex short and weekly windows", () => {
	const config: QuotaStatusConfig = normalizeConfig({
		adapters: [{ name: "generic", provider: "openai-codex", models: ["*"] }],
	});
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "openai-codex", model: "gpt-5.5" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{
						name: "5h",
						limit: 100,
						remaining: 97,
						resetAt: now + 5 * 60 * 60 * 1000,
					},
					{
						name: "weekly",
						limit: 100,
						remaining: 49,
						resetAt: now + 5 * 24 * 60 * 60 * 1000,
					},
					{
						name: "extra-1",
						limit: 100,
						remaining: 1,
						resetAt: now + 60 * 60 * 1000,
					},
				],
			},
			"subscription",
			200,
			now,
		),
	);
	const selected = selectFooterQuotaForModel(state, config, ref, now);
	assert.deepEqual(
		selected?.segments.map((segment) => segment.dimension.name),
		["5h", "weekly"],
	);
	assert.equal(selected?.percentRemaining, 49);
});

test("footer shows Anthropic short window and active model weekly bottleneck", () => {
	const config: QuotaStatusConfig = normalizeConfig({
		adapters: [
			{ name: "anthropic", provider: "anthropic", models: ["claude-*"] },
		],
	});
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "anthropic", model: "claude-sonnet-4" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{ name: "5h", limit: 100, remaining: 82 },
					{ name: "weekly", limit: 100, remaining: 60 },
					{ name: "weekly_sonnet", limit: 100, remaining: 25 },
					{ name: "weekly_opus", limit: 100, remaining: 4 },
				],
			},
			"subscription",
			200,
			now,
		),
	);
	const selected = selectFooterQuotaForModel(state, config, ref, now);
	assert.deepEqual(
		selected?.segments.map((segment) => segment.dimension.name),
		["5h", "weekly_sonnet"],
	);
	assert.equal(selected?.percentRemaining, 25);
});

test("subscription quota still surfaces an exhausted weekly window", () => {
	const config: QuotaStatusConfig = normalizeConfig({
		adapters: [{ name: "generic", provider: "openai-codex", models: ["*"] }],
	});
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "openai-codex", model: "gpt-5.5" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{
						name: "5h",
						limit: 100,
						remaining: 97,
						resetAt: now + 5 * 60 * 60 * 1000,
					},
					{
						name: "weekly",
						limit: 100,
						remaining: 0,
						resetAt: now + 5 * 24 * 60 * 60 * 1000,
					},
				],
			},
			"subscription",
			200,
			now,
		),
	);
	const selected = selectQuotaForModel(state, config, ref, now);
	assert.equal(selected?.dimension.name, "weekly");
	assert.equal(selected?.percentRemaining, 0);
});

test("healthy Codex metadata hides a persisted bogus 5h zero", () => {
	const config: QuotaStatusConfig = normalizeConfig({
		adapters: [{ name: "generic", provider: "openai-codex", models: ["*"] }],
	});
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "openai-codex", model: "gpt-5.5" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{
						name: "5h",
						limit: 100,
						remaining: 0,
						resetAt: now + 5 * 60 * 60 * 1000,
					},
					{
						name: "weekly",
						limit: 100,
						remaining: 79,
						resetAt: now + 5 * 24 * 60 * 60 * 1000,
					},
				],
				metadata: {
					allowed: true,
					limitReached: false,
					rateLimitReachedType: null,
				},
			},
			"subscription",
			200,
			now,
		),
	);

	const selected = selectQuotaForModel(state, config, ref, now);
	assert.equal(selected?.dimension.name, "weekly");
	assert.equal(selected?.percentRemaining, 79);
	assert.deepEqual(
		selectFooterQuotaForModel(state, config, ref, now)?.segments.map(
			(segment) => segment.dimension.name,
		),
		["weekly"],
	);
});

test("suspicious Codex 5h quota drop is suppressed until confirmed", () => {
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "openai-codex", model: "gpt-5.5" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{ name: "5h", limit: 100, remaining: 97, resetAt: now + 18_000_000 },
					{
						name: "weekly",
						limit: 100,
						remaining: 94,
						resetAt: now + 604_800_000,
					},
				],
			},
			"subscription",
			200,
			now,
		),
	);
	const suspicious = observationFromParsed(
		ref,
		{ name: "subscription" },
		{
			dimensions: [
				{ name: "5h", limit: 100, remaining: 0, resetAt: now + 18_000_000 },
				{
					name: "weekly",
					limit: 100,
					remaining: 94,
					resetAt: now + 604_800_000,
				},
			],
		},
		"subscription",
		200,
		now + 60_000,
		state.observations["openai-codex/gpt-5.5"],
	);

	const first = applySubscriptionObservation(state, suspicious, now + 60_000);
	assert.equal(first.action, "suppressed");
	assert.equal(
		state.observations["openai-codex/gpt-5.5"]?.dimensions[0]?.remaining,
		97,
	);
	assert.equal(
		state.pendingObservations?.["openai-codex/gpt-5.5"]?.newRemaining,
		0,
	);

	const second = applySubscriptionObservation(state, suspicious, now + 67_000);
	assert.equal(second.action, "confirmed");
	assert.equal(
		state.observations["openai-codex/gpt-5.5"]?.dimensions[0]?.remaining,
		0,
	);
	assert.equal(state.pendingObservations?.["openai-codex/gpt-5.5"], undefined);
});

test("explicit Codex block signal accepts near-zero quota immediately", () => {
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "openai-codex", model: "gpt-5.5" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{ name: "5h", limit: 100, remaining: 97, resetAt: now + 18_000_000 },
				],
			},
			"subscription",
			200,
			now,
		),
	);
	const blocked = observationFromParsed(
		ref,
		{ name: "subscription" },
		{
			dimensions: [
				{ name: "5h", limit: 100, remaining: 0, resetAt: now + 18_000_000 },
			],
			metadata: {
				allowed: false,
				limitReached: true,
				rateLimitReachedType: "primary",
			},
		},
		"subscription",
		200,
		now + 60_000,
		state.observations["openai-codex/gpt-5.5"],
	);

	const result = applySubscriptionObservation(state, blocked, now + 60_000);
	assert.equal(result.action, "accepted");
	assert.equal(
		state.observations["openai-codex/gpt-5.5"]?.dimensions[0]?.remaining,
		0,
	);
	assert.equal(state.pendingObservations?.["openai-codex/gpt-5.5"], undefined);
});

test("sane Codex poll clears pending suspicious quota", () => {
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "openai-codex", model: "gpt-5.5" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{ name: "5h", limit: 100, remaining: 97, resetAt: now + 18_000_000 },
				],
			},
			"subscription",
			200,
			now,
		),
	);
	applySubscriptionObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{ name: "5h", limit: 100, remaining: 0, resetAt: now + 18_000_000 },
				],
			},
			"subscription",
			200,
			now + 60_000,
			state.observations["openai-codex/gpt-5.5"],
		),
		now + 60_000,
	);
	const sane = observationFromParsed(
		ref,
		{ name: "subscription" },
		{
			dimensions: [
				{ name: "5h", limit: 100, remaining: 95, resetAt: now + 18_000_000 },
			],
		},
		"subscription",
		200,
		now + 67_000,
		state.observations["openai-codex/gpt-5.5"],
	);

	const result = applySubscriptionObservation(state, sane, now + 67_000);
	assert.equal(result.action, "accepted");
	assert.equal(
		state.observations["openai-codex/gpt-5.5"]?.dimensions[0]?.remaining,
		95,
	);
	assert.equal(state.pendingObservations?.["openai-codex/gpt-5.5"], undefined);
});

test("unblocked Codex rollover zero is suppressed until sane", () => {
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "openai-codex", model: "gpt-5.5" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{ name: "5h", limit: 100, remaining: 99, resetAt: now - 1_000 },
					{
						name: "weekly",
						limit: 100,
						remaining: 79,
						resetAt: now + 604_800_000,
					},
				],
			},
			"subscription",
			200,
			now - 60_000,
		),
	);
	const unblockedZero = observationFromParsed(
		ref,
		{ name: "subscription" },
		{
			dimensions: [
				{ name: "5h", limit: 100, remaining: 0, resetAt: now + 18_000_000 },
				{
					name: "weekly",
					limit: 100,
					remaining: 79,
					resetAt: now + 604_800_000,
				},
			],
			metadata: {
				allowed: true,
				limitReached: false,
				rateLimitReachedType: null,
			},
		},
		"subscription",
		200,
		now,
		state.observations["openai-codex/gpt-5.5"],
	);

	const first = applySubscriptionObservation(state, unblockedZero, now);
	assert.equal(first.action, "suppressed");
	assert.equal(/contradicted/.test(first.reason ?? ""), true);
	assert.equal(
		state.observations["openai-codex/gpt-5.5"]?.dimensions[0]?.remaining,
		99,
	);

	const second = applySubscriptionObservation(
		state,
		unblockedZero,
		now + 8_000,
	);
	assert.equal(second.action, "suppressed");
	assert.equal(
		state.observations["openai-codex/gpt-5.5"]?.dimensions[0]?.remaining,
		99,
	);

	const sane = observationFromParsed(
		ref,
		{ name: "subscription" },
		{
			dimensions: [
				{ name: "5h", limit: 100, remaining: 98, resetAt: now + 18_000_000 },
				{
					name: "weekly",
					limit: 100,
					remaining: 79,
					resetAt: now + 604_800_000,
				},
			],
			metadata: {
				allowed: true,
				limitReached: false,
				rateLimitReachedType: null,
			},
		},
		"subscription",
		200,
		now + 60_000,
		state.observations["openai-codex/gpt-5.5"],
	);
	const accepted = applySubscriptionObservation(state, sane, now + 60_000);
	assert.equal(accepted.action, "accepted");
	assert.equal(
		state.observations["openai-codex/gpt-5.5"]?.dimensions[0]?.remaining,
		98,
	);
	assert.equal(state.pendingObservations?.["openai-codex/gpt-5.5"], undefined);
});

test("old expired Codex prior does not trigger rollover suppression", () => {
	const state: QuotaState = { version: 1, observations: {} };
	const ref = { provider: "openai-codex", model: "gpt-5.5" };
	upsertObservation(
		state,
		observationFromParsed(
			ref,
			{ name: "subscription" },
			{
				dimensions: [
					{
						name: "5h",
						limit: 100,
						remaining: 99,
						resetAt: now - 30 * 24 * 60 * 60 * 1000,
					},
				],
			},
			"subscription",
			200,
			now - 30 * 24 * 60 * 60 * 1000,
		),
	);
	const staleZero = observationFromParsed(
		ref,
		{ name: "subscription" },
		{
			dimensions: [
				{ name: "5h", limit: 100, remaining: 0, resetAt: now + 18_000_000 },
			],
		},
		"subscription",
		200,
		now,
		state.observations["openai-codex/gpt-5.5"],
	);

	const result = applySubscriptionObservation(state, staleZero, now);
	assert.equal(result.action, "accepted");
	assert.equal(
		state.observations["openai-codex/gpt-5.5"]?.dimensions[0]?.remaining,
		0,
	);
	assert.equal(state.pendingObservations?.["openai-codex/gpt-5.5"], undefined);
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
		buildQuotaRows(config, state, [{ provider: "openai", id: "gpt-5.5" }], now),
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
