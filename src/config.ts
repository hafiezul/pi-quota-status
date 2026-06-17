import { existsSync } from "node:fs";
import type { AdapterConfig, LoadResult, QuotaStatusConfig } from "./types.js";
import { readJsonFile, writeJsonFileAtomic } from "./storage.js";

export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
export const DEFAULT_WARNING_THRESHOLD = 25;
export const DEFAULT_CRITICAL_THRESHOLD = 10;

export const DEFAULT_CONFIG: Required<
	Pick<
		QuotaStatusConfig,
		"version" | "refreshIntervalMs" | "warningThreshold" | "criticalThreshold"
	>
> & {
	adapters: AdapterConfig[];
} = {
	version: 1,
	refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
	warningThreshold: DEFAULT_WARNING_THRESHOLD,
	criticalThreshold: DEFAULT_CRITICAL_THRESHOLD,
	adapters: [
		{
			name: "anthropic",
			type: "anthropic",
			provider: "anthropic",
			models: ["claude-*"],
		},
		{
			name: "generic-openai-compatible",
			type: "generic",
			provider: "*",
			models: ["*"],
			dimensions: [
				{
					dimension: "requests",
					limit: "x-ratelimit-limit-requests",
					remaining: "x-ratelimit-remaining-requests",
					reset: "x-ratelimit-reset-requests",
					retryAfter: "retry-after",
				},
				{
					dimension: "tokens",
					limit: "x-ratelimit-limit-tokens",
					remaining: "x-ratelimit-remaining-tokens",
					reset: "x-ratelimit-reset-tokens",
					retryAfter: "retry-after",
				},
			],
		},
	],
};

export const CONFIG_TEMPLATE: QuotaStatusConfig = {
	version: 1,
	refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
	warningThreshold: DEFAULT_WARNING_THRESHOLD,
	criticalThreshold: DEFAULT_CRITICAL_THRESHOLD,
	adapters: [
		{
			name: "anthropic",
			type: "anthropic",
			provider: "anthropic",
			models: ["claude-*"],
			fallback: {
				enabled: false,
				dimension: "messages",
				limit: 45,
				windowSeconds: 5 * 60 * 60,
				consume: { unit: "turns", amount: 1 },
			},
		},
		{
			name: "openai-example",
			type: "generic",
			enabled: false,
			provider: "openai*",
			models: ["gpt-*", "o*", "chatgpt-*"],
			dimensions: [
				{
					dimension: "requests",
					limit: "x-ratelimit-limit-requests",
					remaining: "x-ratelimit-remaining-requests",
					reset: "x-ratelimit-reset-requests",
					retryAfter: "retry-after",
				},
				{
					dimension: "tokens",
					limit: "x-ratelimit-limit-tokens",
					remaining: "x-ratelimit-remaining-tokens",
					reset: "x-ratelimit-reset-tokens",
					retryAfter: "retry-after",
				},
			],
		},
	],
};

export function normalizeConfig(
	config: QuotaStatusConfig | undefined,
): QuotaStatusConfig {
	if (!config || typeof config !== "object")
		return { ...DEFAULT_CONFIG, adapters: [...DEFAULT_CONFIG.adapters] };
	const adapters =
		Array.isArray(config.adapters) && config.adapters.length > 0
			? config.adapters
			: DEFAULT_CONFIG.adapters;
	return {
		version: 1,
		refreshIntervalMs: positiveNumber(
			config.refreshIntervalMs,
			DEFAULT_REFRESH_INTERVAL_MS,
		),
		warningThreshold: positiveNumber(
			config.warningThreshold,
			DEFAULT_WARNING_THRESHOLD,
		),
		criticalThreshold: positiveNumber(
			config.criticalThreshold,
			DEFAULT_CRITICAL_THRESHOLD,
		),
		adapters: adapters
			.map(normalizeAdapter)
			.filter((adapter) => adapter.enabled !== false),
	};
}

function normalizeAdapter(adapter: AdapterConfig): AdapterConfig {
	return {
		...adapter,
		name: adapter.name || adapter.type || "generic",
		type: adapter.type ?? "generic",
		provider: adapter.provider ?? "*",
		models:
			Array.isArray(adapter.models) && adapter.models.length > 0
				? adapter.models
				: ["*"],
	};
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

export async function loadConfig(
	configFile: string,
): Promise<LoadResult<QuotaStatusConfig>> {
	const result = await readJsonFile<QuotaStatusConfig>(
		configFile,
		DEFAULT_CONFIG,
	);
	return {
		path: configFile,
		value: normalizeConfig(result.value),
		error: result.error,
	};
}

export async function ensureConfigTemplate(
	configFile: string,
): Promise<LoadResult<QuotaStatusConfig>> {
	if (existsSync(configFile)) {
		const existing = await readJsonFile<QuotaStatusConfig | undefined>(
			configFile,
			undefined,
		);
		return {
			path: configFile,
			value: normalizeConfig(existing.value),
			error: existing.error,
			created: false,
		};
	}
	await writeJsonFileAtomic(configFile, CONFIG_TEMPLATE, { exclusive: true });
	return {
		path: configFile,
		value: normalizeConfig(CONFIG_TEMPLATE),
		created: true,
	};
}
