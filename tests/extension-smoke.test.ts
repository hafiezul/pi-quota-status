import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import quotaStatusExtension from "../src/index.js";
import {
	extractChatGPTAccountId,
	fetchOpenAICodexQuota,
	fetchSubscriptionQuota,
	parseAnthropicUsage,
	parseOpenAICodexUsage,
} from "../src/subscription.js";
import {
	stubCtx,
	stubGlobalFetch,
	stubGlobalFetchPending,
	stubPi,
	useTempQuotaDir,
} from "./helpers.js";

test("extension registers expected events and /quota command", () => {
	const stub = stubPi();
	quotaStatusExtension(stub.api);
	assert.deepEqual([...stub.handlers.keys()], [
		"session_start",
		"session_shutdown",
		"model_select",
		"after_provider_response",
	]);
	assert.ok(stub.commands.has("quota"));
});

test("session start renders saved quota before subscription refresh finishes", async () => {
	const storage = await useTempQuotaDir();
	await writeFile(
		join(storage.dir, "config.json"),
		JSON.stringify({
			refreshIntervalMs: 60_000,
			adapters: [
				{
					name: "anthropic",
					type: "anthropic",
					provider: "anthropic",
					models: ["claude-*"],
				},
			],
		}),
	);
	await writeFile(
		join(storage.dir, "state.json"),
		JSON.stringify({
			version: 1,
			observations: {
				"anthropic/claude-sonnet-4": {
					provider: "anthropic",
					model: "claude-sonnet-4",
					source: "subscription",
					status: 200,
					observedAt: Date.now() - 1_000,
					updatedAt: Date.now() - 1_000,
					dimensions: [
						{
							name: "5h",
							limit: 100,
							remaining: 72,
							observedAt: Date.now() - 1_000,
							source: "subscription",
						},
					],
				},
			},
		}),
	);

	const fetchStub = stubGlobalFetchPending();
	let resolveStatus!: () => void;
	const refreshedStatus = new Promise<void>((resolve) => {
		resolveStatus = resolve;
	});
	const statuses: Array<string | undefined> = [];
	const model = { provider: "anthropic", id: "claude-sonnet-4" };
	const ctx = stubCtx({
		model,
		statuses: statuses,
		modelRegistry: {
			isUsingOAuth(candidate) {
				return candidate === model;
			},
			async getApiKeyForProvider() {
				return "oauth-token";
			},
		},
		onStatus(text) {
			if (text !== undefined && text.includes("70%")) resolveStatus();
		},
	});
	const stub = stubPi();
	quotaStatusExtension(stub.api);
	const sessionStart = stub.handlers.get("session_start");
	if (!sessionStart) throw new Error("session_start handler was not registered");
	const startupPromise = Promise.resolve(sessionStart({ reason: "startup" }, ctx));
	try {
		await fetchStub.wasCalled();
		const startupCompleted = await Promise.race([
			startupPromise.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
		]);
		assert.equal(startupCompleted, true);
		assert.equal(/5h 72%/.test(statuses[0] ?? ""), true);

		fetchStub.release({
			ok: true,
			status: 200,
			async json() {
				return { five_hour: { utilization: 30 } };
			},
		});
		await startupPromise;
		await refreshedStatus;
		assert.equal(/5h 70%/.test(statuses.at(-1) ?? ""), true);
	} finally {
		fetchStub.release({
			ok: true,
			status: 200,
			async json() {
				return { five_hour: { utilization: 30 } };
			},
		});
		await startupPromise.catch(() => undefined);
		const shutdown = stub.handlers.get("session_shutdown");
		if (shutdown) await shutdown({ reason: "test" }, ctx);
		fetchStub.restore();
		await storage.cleanup();
	}
});

test("/quota status is accepted as table alias", async () => {
	const stub = stubPi();
	quotaStatusExtension(stub.api);
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	await stub.commands.get("quota")?.handler(
		"status",
		stubCtx({ statuses, notifications }),
	);
	assert.deepEqual(notifications, []);
	assert.deepEqual(stub.messages, ["No tracked quota data yet."]);
});

test("/quota status explains subscription quota unavailability", async () => {
	const stub = stubPi();
	quotaStatusExtension(stub.api);
	const model = { provider: "openai-codex", id: "gpt-5.5" };
	await stub.commands.get("quota")?.handler(
		"status",
		stubCtx({
			model,
			modelRegistry: {
				isUsingOAuth(candidate) {
					return candidate === model;
				},
			},
		}),
	);
	assert.ok(/No provider quota data/.test(stub.messages[0] ?? ""));
});

test("custom key models show header quota", async () => {
	const stub = stubPi();
	quotaStatusExtension(stub.api);
	const statuses: Array<string | undefined> = [];
	const ctx = stubCtx({
		model: { provider: "openai", id: "gpt-5.5" },
		modelRegistry: { isUsingOAuth() { return false; } },
		statuses,
	});
	await stub.handlers.get("after_provider_response")!(
		{ status: 200, headers: {
			"x-ratelimit-limit-requests": "100",
			"x-ratelimit-remaining-requests": "72",
		} },
		ctx,
	);
	assert.deepEqual(statuses, ["Req 72%"]);
});

test("providers without quota data clear extension status", async () => {
	const stub = stubPi();
	quotaStatusExtension(stub.api);
	const statuses: Array<string | undefined> = [];
	await stub.handlers.get("after_provider_response")!(
		{ status: 200, headers: {} },
		stubCtx({
			model: { provider: "custom-provider", id: "custom-model" },
			statuses,
		}),
	);
	assert.deepEqual(statuses, [undefined]);
});

test("OAuth-backed native providers are not labeled as subscriptions", async () => {
	const stub = stubPi();
	quotaStatusExtension(stub.api);
	const statuses: Array<string | undefined> = [];
	await stub.handlers.get("after_provider_response")!(
		{ status: 200, headers: {} },
		stubCtx({
			model: { provider: "commandcode", id: "meta/muse-spark-1.3-contributor" },
			modelRegistry: { isUsingOAuth() { return true; } },
			statuses,
		}),
	);
	assert.deepEqual(statuses, ["quota n/a"]);
});

test("model selection repaints saved state and refreshes in background", async () => {
	const storage = await useTempQuotaDir();
	const fetchStub = stubGlobalFetchPending();
	try {
		await writeFile(
			join(storage.dir, "config.json"),
			JSON.stringify({
				refreshIntervalMs: 60_000,
				adapters: [
					{
						name: "anthropic",
						type: "anthropic",
						provider: "anthropic",
						models: ["claude-*"],
					},
				],
			}),
		);
		const statuses: Array<string | undefined> = [];
		const model = { provider: "anthropic", id: "claude-sonnet-4" };
		const ctx = stubCtx({
			model,
			statuses,
			modelRegistry: {
				isUsingOAuth(candidate) {
					return candidate === model;
				},
				async getApiKeyForProvider() {
					return "oauth-token";
				},
			},
		});
		const stub = stubPi();
		quotaStatusExtension(stub.api);
		const modelSelect = stub.handlers.get("model_select");
		if (!modelSelect) throw new Error("model_select handler was not registered");
		const modelSelectDone = (async () => {
			await modelSelect({ model, source: "set" }, ctx);
			return true;
		})();
		const resolved = await Promise.race([
			modelSelectDone,
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
		]);
		assert.equal(resolved, true, "model_select must not block on the quota poll");
		assert.equal(statuses.length >= 1, true);
		assert.equal(/quota n\/a/.test(statuses[0] ?? ""), true);

		fetchStub.release({
			ok: true,
			status: 200,
			async json() {
				return { five_hour: { utilization: 20 } };
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(/5h 80%/.test(statuses.at(-1) ?? ""), true);
	} finally {
		fetchStub.release({
			ok: true,
			status: 200,
			async json() {
				return { five_hour: { utilization: 20 } };
			},
		});
		fetchStub.restore();
		await storage.cleanup();
	}
});

test("OpenAI Codex subscription usage parses quota windows", () => {
	const parsed = parseOpenAICodexUsage(
		{
			rate_limit: {
				primary_window: {
					used_percent: 28,
					reset_at: 1_767_200_400,
				},
				secondary_window: {
					used_percent: 65,
					reset_at: 1_767_805_200,
				},
			},
		},
		Date.UTC(2026, 0, 1, 0, 0, 0),
	);

	assert.equal(parsed?.dimensions.length, 2);
	assert.equal(parsed?.dimensions[0]?.name, "5h");
	assert.equal(parsed?.dimensions[0]?.limit, 100);
	assert.equal(parsed?.dimensions[0]?.remaining, 72);
	assert.equal(parsed?.dimensions[0]?.resetAt, 1_767_200_400_000);
	assert.equal(parsed?.dimensions[1]?.name, "weekly");
	assert.equal(parsed?.dimensions[1]?.remaining, 35);
});

test("OpenAI Codex subscription treats used_percent 1 as one percent used", () => {
	const parsed = parseOpenAICodexUsage(
		{
			rate_limit: {
				secondary_window: {
					used_percent: 1,
				},
			},
		},
		Date.UTC(2026, 0, 1, 0, 0, 0),
	);

	assert.equal(parsed?.dimensions[0]?.name, "weekly");
	assert.equal(parsed?.dimensions[0]?.remaining, 99);
});

test("OpenAI Codex subscription usage parses block metadata and extra limits", () => {
	const parsed = parseOpenAICodexUsage(
		{
			rate_limit: {
				allowed: false,
				limit_reached: true,
				primary_window: {
					used_percent: 100,
					reset_at: 1_767_200_400,
				},
			},
			rate_limit_reached_type: "primary",
			additional_rate_limits: [
				{
					id: "GPT-5.3-Codex-Spark",
					used_percent: 12,
					reset_at: 1_767_200_500,
				},
			],
		},
		Date.UTC(2026, 0, 1, 0, 0, 0),
		{ accountHeaderSent: true },
	);

	assert.equal(parsed?.metadata?.accountHeaderSent, true);
	assert.equal(parsed?.metadata?.allowed, false);
	assert.equal(parsed?.metadata?.limitReached, true);
	assert.equal(parsed?.metadata?.rateLimitReachedType, "primary");
	assert.equal(parsed?.metadata?.extraLimits?.[0]?.name, "GPT-5.3-Codex-Spark");
	assert.equal(parsed?.metadata?.extraLimits?.[0]?.remaining, 88);
});

test("OpenAI Codex account id is extracted from OAuth JWT", () => {
	assert.equal(
		extractChatGPTAccountId(
			"header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xMjMifX0.sig",
		),
		"acct_123",
	);
	assert.equal(extractChatGPTAccountId("not-a-jwt"), undefined);
});

test("Anthropic subscription usage parses quota windows", () => {
	const parsed = parseAnthropicUsage(
		{
			five_hour: {
				utilization: 22,
				resets_at: "2026-01-01T05:00:00Z",
			},
			seven_day: {
				utilization: 60,
				resets_at: "2026-01-05T08:00:00Z",
			},
			seven_day_sonnet: {
				utilization: 0.8,
				resets_at: "2026-01-04T08:00:00Z",
			},
		},
		Date.UTC(2026, 0, 1, 0, 0, 0),
	);

	assert.equal(parsed?.dimensions.length, 3);
	assert.equal(parsed?.dimensions[0]?.name, "5h");
	assert.equal(parsed?.dimensions[0]?.remaining, 78);
	assert.equal(parsed?.dimensions[0]?.resetAt, Date.UTC(2026, 0, 1, 5, 0, 0));
	assert.equal(parsed?.dimensions[2]?.name, "weekly_sonnet");
	assert.equal(parsed?.dimensions[2]?.remaining, 20);
});

test("subscription quota fetch uses Pi OAuth token for OpenAI Codex", async () => {
	const fetchStub = stubGlobalFetch(() => ({
		ok: true,
		status: 200,
		async json() {
			return {
				rate_limit: {
					primary_window: {
						used_percent: 40,
						reset_after_seconds: 300,
					},
				},
			};
		},
	}));
	try {
		const parsed = await fetchSubscriptionQuota(
			stubCtx({
				modelRegistry: {
					async getApiKeyForProvider(provider) {
						assert.equal(provider, "openai-codex");
						return "oauth-token";
					},
				},
			}),
			{ provider: "openai-codex", model: "gpt-5.5" },
			Date.UTC(2026, 0, 1, 0, 0, 0),
		);

		assert.equal(fetchStub.requestedUrls[0], "https://chatgpt.com/backend-api/wham/usage");
		assert.equal(fetchStub.lastInit?.headers?.authorization, "Bearer oauth-token");
		assert.equal(parsed?.dimensions[0]?.remaining, 60);
		assert.equal(parsed?.dimensions[0]?.resetAt, Date.UTC(2026, 0, 1, 0, 5, 0));
	} finally {
		fetchStub.restore();
	}
});

test("OpenAI Codex healthy zero uses CLI RPC fallback when available", async () => {
	const fetchStub = stubGlobalFetch(() => ({
		ok: true,
		status: 200,
		async json() {
			return {
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: {
						used_percent: 100,
						reset_at: 1_767_218_000,
					},
					secondary_window: {
						used_percent: 35,
						reset_at: 1_767_805_200,
					},
				},
			};
		},
	}));
	try {
		const parsed = await fetchOpenAICodexQuota(
			"oauth-token",
			Date.UTC(2026, 0, 1, 0, 0, 0),
			{
				async fetchCliRateLimits() {
					return {
						dimensions: [
							{
								name: "5h",
								limit: 100,
								remaining: 91,
								resetAt: 1_767_217_391_000,
							},
							{
								name: "weekly",
								limit: 100,
								remaining: 64,
								resetAt: 1_767_805_246_000,
							},
						],
					};
				},
			},
		);

		assert.equal(parsed?.dimensions[0]?.name, "5h");
		assert.equal(parsed?.dimensions[0]?.remaining, 91);
		assert.equal(parsed?.dimensions[1]?.name, "weekly");
		assert.equal(parsed?.dimensions[1]?.remaining, 64);
		assert.equal(parsed?.metadata?.codexCliRpcFallback, true);
	} finally {
		fetchStub.restore();
	}
});

test("subscription quota fetch sends ChatGPT account header when OAuth JWT contains it", async () => {
	const fetchStub = stubGlobalFetch(() => ({
		ok: true,
		status: 200,
		async json() {
			return {
				rate_limit: {
					primary_window: {
						used_percent: 40,
						reset_after_seconds: 300,
					},
				},
			};
		},
	}));
	try {
		await fetchSubscriptionQuota(
			stubCtx({
				modelRegistry: {
					async getApiKeyForProvider() {
						return "header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xMjMifX0.sig";
					},
				},
			}),
			{ provider: "openai-codex", model: "gpt-5.5" },
			Date.UTC(2026, 0, 1, 0, 0, 0),
		);

		assert.equal(fetchStub.lastInit?.headers?.["ChatGPT-Account-Id"], "acct_123");
	} finally {
		fetchStub.restore();
	}
});

test("subscription quota fetch uses Pi OAuth token for Anthropic", async () => {
	const fetchStub = stubGlobalFetch(() => ({
		ok: true,
		status: 200,
		async json() {
			return {
				five_hour: {
					utilization: 0.25,
					resets_at: "2026-01-01T01:00:00Z",
				},
			};
		},
	}));
	try {
		const parsed = await fetchSubscriptionQuota(
			stubCtx({
				modelRegistry: {
					async getApiKeyForProvider(provider) {
						assert.equal(provider, "anthropic");
						return "oauth-token";
					},
				},
			}),
			{ provider: "anthropic", model: "claude-sonnet-4" },
			Date.UTC(2026, 0, 1, 0, 0, 0),
		);

		assert.equal(fetchStub.requestedUrls[0], "https://api.anthropic.com/api/oauth/usage");
		assert.equal(fetchStub.lastInit?.headers?.authorization, "Bearer oauth-token");
		assert.equal(fetchStub.lastInit?.headers?.["anthropic-beta"], "oauth-2025-04-20");
		assert.equal(parsed?.dimensions[0]?.remaining, 75);
	} finally {
		fetchStub.restore();
	}
});
