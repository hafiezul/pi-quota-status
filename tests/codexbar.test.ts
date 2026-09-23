import test from "node:test";
import assert from "node:assert/strict";
import {
	CODEXBAR_PROVIDER_IDS,
	codexBarCLIName,
	fetchCodexBarQuota,
	parseCodexBarUsage,
	resolveCodexBarProvider,
} from "../src/codexbar.js";

test("CodexBar provider registry mirrors all supported provider ids", () => {
	assert.equal(CODEXBAR_PROVIDER_IDS.length, 80);
	assert.equal(new Set(CODEXBAR_PROVIDER_IDS).size, 80);
	assert.ok(CODEXBAR_PROVIDER_IDS.includes("codex"));
	assert.ok(CODEXBAR_PROVIDER_IDS.includes("gitkraken"));
});

test("Pi provider ids resolve to CodexBar provider ids", () => {
	assert.equal(resolveCodexBarProvider("openai-codex", true), "codex");
	assert.equal(resolveCodexBarProvider("anthropic", true), "claude");
	assert.equal(resolveCodexBarProvider("azure-openai-responses"), "azureopenai");
	assert.equal(resolveCodexBarProvider("azure-openai"), "azureopenai");
	assert.equal(resolveCodexBarProvider("google"), "gemini");
	assert.equal(resolveCodexBarProvider("google-vertex"), "vertexai");
	assert.equal(resolveCodexBarProvider("github-copilot"), "copilot");
	assert.equal(resolveCodexBarProvider("amazon-bedrock"), "bedrock");
	assert.equal(resolveCodexBarProvider("opencode-go"), "opencodego");
	assert.equal(resolveCodexBarProvider("qwen-token-plan"), "qwencloud");
	assert.equal(resolveCodexBarProvider("qwen-cloud"), "qwencloud");
	assert.equal(resolveCodexBarProvider("abacusai"), "abacus");
	assert.equal(resolveCodexBarProvider("groqcloud"), "groq");
	assert.equal(resolveCodexBarProvider("xiaomi-token-plan-sgp"), "mimo");
	assert.equal(resolveCodexBarProvider("xai", true), "grok");
	assert.equal(resolveCodexBarProvider("xai", false), "xai");
	assert.equal(resolveCodexBarProvider("gitkraken"), "gitkraken");
	assert.equal(resolveCodexBarProvider("unknown-provider"), undefined);
});

test("CodexBar provider ids map to canonical CLI names", () => {
	assert.equal(codexBarCLIName("azureopenai"), "azure-openai");
	assert.equal(codexBarCLIName("alibaba"), "alibaba-coding-plan");
	assert.equal(codexBarCLIName("alibabatokenplan"), "alibaba-token-plan");
	assert.equal(codexBarCLIName("qwencloud"), "qwen-cloud");
	assert.equal(codexBarCLIName("abacus"), "abacusai");
	assert.equal(codexBarCLIName("groq"), "groqcloud");
	assert.equal(codexBarCLIName("gitkraken"), "gitkraken");
});

test("CodexBar JSON usage parses primary and secondary quota windows", () => {
	const parsed = parseCodexBarUsage(
		{
			provider: "codex",
			usage: {
				primary: {
					usedPercent: 28,
					windowMinutes: 300,
					resetsAt: "2026-01-01T05:00:00Z",
				},
				secondary: {
					usedPercent: 59,
					windowMinutes: 10080,
					resetsAt: "2026-01-08T00:00:00Z",
				},
			},
		},
		"codex",
	);

	assert.deepEqual(parsed?.dimensions, [
		{
			name: "5h",
			limit: 100,
			remaining: 72,
			resetAt: Date.UTC(2026, 0, 1, 5, 0, 0),
		},
		{
			name: "weekly",
			limit: 100,
			remaining: 41,
			resetAt: Date.UTC(2026, 0, 8, 0, 0, 0),
		},
	]);
});

test("CodexBar array output selects the requested provider", () => {
	const parsed = parseCodexBarUsage(
		[
			{ provider: "claude", usage: { primary: { usedPercent: 90 } } },
			{ provider: "gemini", usage: { primary: { usedPercent: 25 } } },
		],
		"gemini",
	);

	assert.equal(parsed?.dimensions[0]?.remaining, 75);
});

test("CodexBar fetch uses the mapped provider and parses JSON", async () => {
	let args: string[] = [];
	const parsed = await fetchCodexBarQuota(
		{ provider: "google", model: "gemini-3.1-pro-preview" },
		false,
		async (nextArgs) => {
			args = nextArgs;
			return JSON.stringify({
				provider: "gemini",
				usage: { primary: { usedPercent: 33, windowMinutes: 300 } },
			});
		},
	);

	assert.deepEqual(args, ["usage", "--provider", "gemini", "--format", "json"]);
	assert.equal(parsed?.dimensions[0]?.remaining, 67);
});

test("CodexBar fetch uses canonical CLI spelling for aliased providers", async () => {
	let args: string[] = [];
	const parsed = await fetchCodexBarQuota(
		{ provider: "qwen-token-plan", model: "qwen3-coder" },
		false,
		async (nextArgs) => {
			args = nextArgs;
			return JSON.stringify({
				provider: "qwencloud",
				usage: { primary: { usedPercent: 20 } },
			});
		},
	);

	assert.deepEqual(args, [
		"usage",
		"--provider",
		"qwen-cloud",
		"--format",
		"json",
	]);
	assert.equal(parsed?.dimensions[0]?.remaining, 80);
});

test("CodexBar usage includes labeled and known extra quota windows", () => {
	const parsed = parseCodexBarUsage(
		{
			provider: "cursor",
			rateWindowLabels: { primary: "Requests" },
			usage: {
				primary: { usedPercent: 40 },
				extraRateWindows: [
					{
						id: "cursor-fast",
						title: "Fast requests",
						window: { usedPercent: 25, windowMinutes: 43200 },
					},
					{
						id: "metadata-only",
						title: "Metadata only",
						usageKnown: false,
						window: { usedPercent: 100 },
					},
				],
			},
		},
		"cursor",
	);

	assert.deepEqual(
		parsed?.dimensions.map((dimension) => ({
			name: dimension.name,
			remaining: dimension.remaining,
		})),
		[
			{ name: "Requests", remaining: 60 },
			{ name: "Fast requests", remaining: 75 },
		],
	);
});

test("CodexBar usage ignores synthetic placeholder windows", () => {
	const parsed = parseCodexBarUsage(
		{
			provider: "claude",
			usage: {
				primary: {
					usedPercent: 0,
					windowMinutes: 300,
					isSyntheticPlaceholder: true,
				},
				secondary: { usedPercent: 20, windowMinutes: 10080 },
			},
		},
		"claude",
	);

	assert.deepEqual(
		parsed?.dimensions.map((dimension) => dimension.name),
		["weekly"],
	);
});
