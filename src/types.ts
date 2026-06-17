export type ObservationSource = "headers" | "429" | "fallback" | "subscription";
export type ConsumptionUnit = "turns" | "tokens" | "costUnits";

export type HeaderNames = string | string[];

export interface HeaderFieldMapping {
	dimension?: string;
	limit?: HeaderNames;
	remaining?: HeaderNames;
	reset?: HeaderNames;
	retryAfter?: HeaderNames;
	"retry-after"?: HeaderNames;
}

export interface FallbackConsumptionConfig {
	unit?: ConsumptionUnit;
	amount?: number;
}

export interface FixedWindowFallbackConfig {
	enabled?: boolean;
	dimension?: string;
	limit: number;
	windowSeconds: number;
	/** Optional first reset/window boundary. ISO date, epoch milliseconds, or epoch seconds. */
	resetAt?: string | number;
	consume?: FallbackConsumptionConfig;
}

export interface AdapterConfig {
	name?: string;
	type?: "generic" | "anthropic";
	enabled?: boolean;
	/** Provider glob, e.g. "anthropic" or "*". */
	provider?: string;
	/** Model globs, e.g. ["claude-*"] or ["*"]. */
	models?: string[];
	/** Generic/custom header mappings. */
	headers?: HeaderFieldMapping | HeaderFieldMapping[];
	/** Preferred multi-dimension header mapping form. */
	dimensions?: HeaderFieldMapping[];
	fallback?: FixedWindowFallbackConfig;
}

export interface QuotaStatusConfig {
	version?: 1;
	refreshIntervalMs?: number;
	warningThreshold?: number;
	criticalThreshold?: number;
	adapters?: AdapterConfig[];
}

export interface ModelRef {
	provider: string;
	model: string;
}

export interface ParsedQuotaDimension {
	name: string;
	limit?: number;
	remaining?: number;
	resetAt?: number;
}

export interface ParsedQuotaObservation {
	dimensions: ParsedQuotaDimension[];
	resetAt?: number;
}

export interface QuotaDimensionObservation extends ParsedQuotaDimension {
	observedAt: number;
	source: ObservationSource;
}

export interface QuotaObservation {
	provider: string;
	model: string;
	adapter?: string;
	source: ObservationSource;
	status?: number;
	observedAt: number;
	updatedAt: number;
	dimensions: QuotaDimensionObservation[];
}

export interface QuotaState {
	version: 1;
	observations: Record<string, QuotaObservation>;
}

export interface SelectedQuota {
	observation: QuotaObservation;
	dimension: QuotaDimensionObservation;
	percentRemaining: number;
}

export interface QuotaRow {
	provider: string;
	model: string;
	percent: string;
	reset: string;
	source: string;
	dimension: string;
	freshness: string;
}

export interface LoadResult<T> {
	value: T;
	path: string;
	error?: string;
	created?: boolean;
}
