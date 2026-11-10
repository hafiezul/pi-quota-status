import { existsSync } from "node:fs";
import type {
	AdapterConfig,
	HeaderFieldMapping,
	LoadResult,
	QuotaStatusConfig,
} from "./types.js";
import { asRecord } from "./parse-utils.js";
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
			name: "openai",
			type: "generic",
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

export const CONFIG_TEMPLATE: QuotaStatusConfig = {
	version: 1,
	refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
	warningThreshold: DEFAULT_WARNING_THRESHOLD,
	criticalThreshold: DEFAULT_CRITICAL_THRESHOLD,
	adapters: [
		{
			name: "anthropic",
			type: "anthropic",
			enabled: true,
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
			name: "openai",
			type: "generic",
			enabled: true,
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

export function normalizeConfig(value: unknown): QuotaStatusConfig {
	const config = asRecord(value) ?? {};
	const adapters = Array.isArray(config.adapters)
		? config.adapters
		: DEFAULT_CONFIG.adapters;
	return {
		version: 1,
		refreshIntervalMs: boundedNumber(
			config.refreshIntervalMs,
			DEFAULT_REFRESH_INTERVAL_MS,
			1,
			2 ** 31 - 1,
		),
		warningThreshold: boundedNumber(
			config.warningThreshold,
			DEFAULT_WARNING_THRESHOLD,
			0,
			100,
		),
		criticalThreshold: boundedNumber(
			config.criticalThreshold,
			DEFAULT_CRITICAL_THRESHOLD,
			0,
			100,
		),
		adapters: adapters
			.filter(isAdapterConfig)
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

function boundedNumber(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
): number {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= min &&
		value <= max
		? value
		: fallback;
}

function isAdapterConfig(value: unknown): value is AdapterConfig {
	const adapter = asRecord(value);
	if (!adapter) return false;
	return (
		[adapter.name, adapter.provider].every(
			(field) => field === undefined || typeof field === "string",
		) &&
		(adapter.type === undefined ||
			adapter.type === "generic" ||
			adapter.type === "anthropic") &&
		(adapter.enabled === undefined || typeof adapter.enabled === "boolean") &&
		(adapter.models === undefined ||
			(Array.isArray(adapter.models) &&
				adapter.models.every((model) => typeof model === "string"))) &&
		(adapter.headers === undefined ||
			(Array.isArray(adapter.headers)
				? adapter.headers.every(isHeaderMapping)
				: isHeaderMapping(adapter.headers))) &&
		(adapter.dimensions === undefined ||
			(Array.isArray(adapter.dimensions) &&
				adapter.dimensions.every(isHeaderMapping))) &&
		(adapter.fallback === undefined || isFallbackConfig(adapter.fallback))
	);
}

function isHeaderMapping(value: unknown): value is HeaderFieldMapping {
	const mapping = asRecord(value);
	if (!mapping) return false;
	return (
		(mapping.dimension === undefined ||
			typeof mapping.dimension === "string") &&
		[
			mapping.limit,
			mapping.remaining,
			mapping.reset,
			mapping.retryAfter,
			mapping["retry-after"],
		].every(
			(field) =>
				field === undefined ||
				typeof field === "string" ||
				(Array.isArray(field) &&
					field.every((name) => typeof name === "string")),
		)
	);
}

function isFallbackConfig(
	value: unknown,
): value is NonNullable<AdapterConfig["fallback"]> {
	const fallback = asRecord(value);
	if (!fallback) return false;
	const consume = asRecord(fallback.consume);
	return (
		(fallback.enabled === undefined || typeof fallback.enabled === "boolean") &&
		(fallback.dimension === undefined ||
			typeof fallback.dimension === "string") &&
		typeof fallback.limit === "number" &&
		Number.isFinite(fallback.limit) &&
		fallback.limit > 0 &&
		typeof fallback.windowSeconds === "number" &&
		Number.isFinite(fallback.windowSeconds) &&
		fallback.windowSeconds >= 0.001 &&
		Number.isFinite(fallback.windowSeconds * 1000) &&
		(fallback.resetAt === undefined ||
			typeof fallback.resetAt === "string" ||
			(typeof fallback.resetAt === "number" &&
				Number.isFinite(fallback.resetAt))) &&
		(fallback.consume === undefined ||
			(consume !== undefined &&
				(consume.unit === undefined ||
					consume.unit === "turns" ||
					consume.unit === "tokens" ||
					consume.unit === "costUnits") &&
				(consume.amount === undefined ||
					(typeof consume.amount === "number" &&
						Number.isFinite(consume.amount) &&
						consume.amount > 0))))
	);
}

export async function loadConfig(
	configFile: string,
): Promise<LoadResult<QuotaStatusConfig>> {
	const result = await readJsonFile<unknown>(configFile, DEFAULT_CONFIG);
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
		const existing = await readJsonFile<unknown>(configFile, undefined);
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
