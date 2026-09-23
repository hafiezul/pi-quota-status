import { spawn } from "node:child_process";
import { clampPercent } from "./format.js";
import {
	asRecord,
	booleanValue,
	numberValue,
	stringValue,
	timestampValue,
} from "./parse-utils.js";
import type { ModelRef, ParsedQuotaDimension, ParsedQuotaObservation } from "./types.js";

export const CODEXBAR_PROVIDER_IDS = [
	"codex",
	"openai",
	"azureopenai",
	"claude",
	"clinepass",
	"cursor",
	"opencode",
	"opencodego",
	"alibaba",
	"alibabatokenplan",
	"qwencloud",
	"factory",
	"fireworks",
	"gemini",
	"antigravity",
	"copilot",
	"devin",
	"zai",
	"minimax",
	"manus",
	"kimi",
	"kilo",
	"kiro",
	"vertexai",
	"augment",
	"jetbrains",
	"moonshot",
	"amp",
	"t3chat",
	"ollama",
	"synthetic",
	"openrouter",
	"elevenlabs",
	"warp",
	"windsurf",
	"zed",
	"perplexity",
	"mimo",
	"doubao",
	"sakana",
	"abacus",
	"mistral",
	"deepseek",
	"deepinfra",
	"codebuff",
	"venice",
	"commandcode",
	"qoder",
	"stepfun",
	"bedrock",
	"grok",
	"groq",
	"llmproxy",
	"litellm",
	"bifrost",
	"deepgram",
	"poe",
	"chutes",
	"neuralwatt",
	"helmcode",
	"clawrouter",
	"longcat",
	"sub2api",
	"wayfinder",
	"zenmux",
	"aiand",
	"zoommate",
	"xai",
	"notion",
	"ibmbob",
	"nous",
	"muse",
	"coderabbit",
	"replicate",
	"huggingface",
	"pi",
	"v0",
	"typesafe",
	"hyper",
	"gitkraken",
] as const;

export type CodexBarProviderId = (typeof CODEXBAR_PROVIDER_IDS)[number];
export type CodexBarRunner = (args: string[]) => Promise<string | undefined>;

const CODEXBAR_CLI_NAME_OVERRIDES: Partial<
	Record<CodexBarProviderId, string>
> = {
	abacus: "abacusai",
	alibaba: "alibaba-coding-plan",
	alibabatokenplan: "alibaba-token-plan",
	azureopenai: "azure-openai",
	groq: "groqcloud",
	qwencloud: "qwen-cloud",
};

const CODEXBAR_PROVIDER_BY_CLI_NAME = new Map<string, CodexBarProviderId>();
for (const provider of CODEXBAR_PROVIDER_IDS) {
	CODEXBAR_PROVIDER_BY_CLI_NAME.set(codexBarCLIName(provider), provider);
}

const PI_PROVIDER_ALIASES: Record<string, CodexBarProviderId> = {
	"amazon-bedrock": "bedrock",
	"azure-openai-responses": "azureopenai",
	anthropic: "claude",
	"github-copilot": "copilot",
	google: "gemini",
	"google-vertex": "vertexai",
	"kimi-coding": "kimi",
	"minimax-cn": "minimax",
	moonshotai: "moonshot",
	"moonshotai-cn": "moonshot",
	"openai-codex": "codex",
	"opencode-go": "opencodego",
	"qwen-token-plan": "qwencloud",
	"qwen-token-plan-cn": "qwencloud",
	"qwen-token-plan-individual": "qwencloud",
	"xiaomi-token-plan-ams": "mimo",
	"xiaomi-token-plan-cn": "mimo",
	"xiaomi-token-plan-sgp": "mimo",
	xiaomi: "mimo",
	"zai-coding-cn": "zai",
};

export function resolveCodexBarProvider(
	provider: string,
	isSubscription = false,
): CodexBarProviderId | undefined {
	const normalized = provider.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "xai" && isSubscription) return "grok";
	const alias = PI_PROVIDER_ALIASES[normalized];
	if (alias) return alias;
	const cliProvider = CODEXBAR_PROVIDER_BY_CLI_NAME.get(normalized);
	if (cliProvider) return cliProvider;
	return CODEXBAR_PROVIDER_IDS.find((candidate) => candidate === normalized);
}

export function codexBarCLIName(provider: CodexBarProviderId): string {
	return CODEXBAR_CLI_NAME_OVERRIDES[provider] ?? provider;
}

export async function fetchCodexBarQuota(
	ref: ModelRef,
	isSubscription: boolean,
	runner: CodexBarRunner = runCodexBar,
): Promise<ParsedQuotaObservation | undefined> {
	const provider = resolveCodexBarProvider(ref.provider, isSubscription);
	if (!provider) return undefined;
	const output = await runner([
		"usage",
		"--provider",
		codexBarCLIName(provider),
		"--format",
		"json",
	]);
	if (!output?.trim()) return undefined;
	try {
		return parseCodexBarUsage(JSON.parse(output), provider);
	} catch {
		return undefined;
	}
}

export function parseCodexBarUsage(
	value: unknown,
	expectedProvider?: CodexBarProviderId,
): ParsedQuotaObservation | undefined {
	const payload = selectPayload(value, expectedProvider);
	const usage = asRecord(payload?.usage);
	if (!usage) return undefined;
	const labels = asRecord(payload?.rateWindowLabels ?? payload?.rate_window_labels);
	const dimensions = (["primary", "secondary", "tertiary"] as const)
		.map((slot) =>
			parseUsageWindow(
				slot,
				asRecord(usage[slot]),
				stringValue(labels?.[slot]),
			),
		)
		.filter((dimension): dimension is ParsedQuotaDimension => Boolean(dimension));
	dimensions.push(...parseExtraRateWindows(usage.extraRateWindows ?? usage.extra_rate_windows));
	return dimensions.length > 0 ? { dimensions } : undefined;
}

function selectPayload(
	value: unknown,
	expectedProvider: CodexBarProviderId | undefined,
): Record<string, unknown> | undefined {
	if (!Array.isArray(value)) return asRecord(value);
	const payloads = value
		.map((item) => asRecord(item))
		.filter((item): item is Record<string, unknown> => Boolean(item));
	if (!expectedProvider) return payloads[0];
	return payloads.find(
		(payload) => stringValue(payload.provider)?.toLowerCase() === expectedProvider,
	);
}

function parseUsageWindow(
	slot: "primary" | "secondary" | "tertiary",
	window: Record<string, unknown> | undefined,
	label: string | undefined,
): ParsedQuotaDimension | undefined {
	if (!window) return undefined;
	if (
		booleanValue(
			window.isSyntheticPlaceholder ?? window.is_synthetic_placeholder,
		) === true
	)
		return undefined;
	const usedPercent = numberValue(window.usedPercent ?? window.used_percent);
	if (usedPercent === undefined) return undefined;
	const windowMinutes = numberValue(window.windowMinutes ?? window.window_minutes);
	return {
		name: quotaWindowName(slot, windowMinutes, label),
		limit: 100,
		remaining: clampPercent(100 - usedPercent),
		resetAt: timestampValue(window.resetsAt ?? window.resets_at),
	};
}

function parseExtraRateWindows(value: unknown): ParsedQuotaDimension[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item, index): ParsedQuotaDimension | undefined => {
			const named = asRecord(item);
			if (!named) return undefined;
			if (booleanValue(named.usageKnown ?? named.usage_known) === false)
				return undefined;
			const window = asRecord(named.window);
			if (!window) return undefined;
			if (
				booleanValue(
					window.isSyntheticPlaceholder ?? window.is_synthetic_placeholder,
				) === true
			)
				return undefined;
			const usedPercent = numberValue(window.usedPercent ?? window.used_percent);
			if (usedPercent === undefined) return undefined;
			return {
				name:
					stringValue(named.title) ??
					stringValue(named.id) ??
					`extra-${index + 1}`,
				limit: 100,
				remaining: clampPercent(100 - usedPercent),
				resetAt: timestampValue(window.resetsAt ?? window.resets_at),
			};
		})
		.filter(
			(dimension): dimension is ParsedQuotaDimension => dimension !== undefined,
		);
}

function quotaWindowName(
	slot: "primary" | "secondary" | "tertiary",
	windowMinutes: number | undefined,
	label: string | undefined,
): string {
	if (windowMinutes === 300) return "5h";
	if (windowMinutes === 1_440) return "daily";
	if (windowMinutes === 10_080) return "weekly";
	if (windowMinutes !== undefined && windowMinutes >= 40_000 && windowMinutes <= 45_000)
		return "monthly";
	return label ?? slot;
}

function runCodexBar(args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn("codexbar", args, {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let output = "";
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 ? output : undefined));
	});
}
