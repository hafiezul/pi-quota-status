import { dirname } from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { asRecord } from "./parse-utils.js";
import type {
	LoadResult,
	ObservationSource,
	PendingQuotaObservation,
	QuotaObservation,
	QuotaState,
} from "./types.js";

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const STALE_OBSERVATION_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_PENDING_MS = 24 * 60 * 60 * 1000;

export function emptyState(): QuotaState {
	return { version: 1, observations: {} };
}

export function normalizeState(value: unknown, now = Date.now()): QuotaState {
	const root = asRecord(value);
	if (!root) return emptyState();
	const observations = Object.fromEntries(
		Object.entries(asRecord(root.observations) ?? {}).filter(
			(entry): entry is [string, QuotaObservation] =>
				isQuotaObservation(entry[1]),
		),
	);
	pruneStaleObservations(observations, now);
	const pendingObservations = Object.fromEntries(
		Object.entries(asRecord(root.pendingObservations) ?? {}).filter(
			(entry): entry is [string, PendingQuotaObservation] =>
				isPendingObservation(entry[1]),
		),
	);
	pruneStalePending(pendingObservations, now);
	const keptPending =
		pendingObservations && Object.keys(pendingObservations).length > 0
			? pendingObservations
			: undefined;
	return {
		version: 1,
		observations,
		...(keptPending ? { pendingObservations: keptPending } : {}),
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function optionalNumbers(
	record: Record<string, unknown>,
	keys: string[],
): boolean {
	return keys.every(
		(key) => record[key] === undefined || isFiniteNumber(record[key]),
	);
}

function isObservationSource(value: unknown): value is ObservationSource {
	return (
		value === "headers" ||
		value === "429" ||
		value === "fallback" ||
		value === "subscription" ||
		value === "provider" ||
		value === "codexbar"
	);
}

function isQuotaObservation(value: unknown): value is QuotaObservation {
	const observation = asRecord(value);
	if (!observation) return false;
	return (
		typeof observation.provider === "string" &&
		typeof observation.model === "string" &&
		isObservationSource(observation.source) &&
		isFiniteNumber(observation.observedAt) &&
		isFiniteNumber(observation.updatedAt) &&
		(observation.adapter === undefined ||
			typeof observation.adapter === "string") &&
		optionalNumbers(observation, ["status"]) &&
		Array.isArray(observation.dimensions) &&
		observation.dimensions.every((value) => {
			const dimension = asRecord(value);
			return (
				dimension !== undefined &&
				typeof dimension.name === "string" &&
				isObservationSource(dimension.source) &&
				isFiniteNumber(dimension.observedAt) &&
				optionalNumbers(dimension, ["limit", "remaining", "resetAt"])
			);
		}) &&
		(observation.metrics === undefined ||
			(Array.isArray(observation.metrics) &&
				observation.metrics.every((value) => {
					const metric = asRecord(value);
					return (
						metric !== undefined &&
						typeof metric.name === "string" &&
						typeof metric.unit === "string" &&
						isFiniteNumber(metric.value) &&
						isFiniteNumber(metric.observedAt) &&
						isObservationSource(metric.source)
					);
				}))) &&
		(observation.metadata === undefined ||
			isQuotaMetadata(observation.metadata))
	);
}

function isQuotaMetadata(
	value: unknown,
): value is NonNullable<QuotaObservation["metadata"]> {
	const metadata = asRecord(value);
	if (!metadata) return false;
	return (
		[
			"accountHeaderSent",
			"allowed",
			"limitReached",
			"codexCliRpcFallback",
		].every(
			(key) =>
				metadata[key] === undefined || typeof metadata[key] === "boolean",
		) &&
		(metadata.rateLimitReachedType === undefined ||
			metadata.rateLimitReachedType === null ||
			typeof metadata.rateLimitReachedType === "string") &&
		(metadata.extraLimits === undefined ||
			(Array.isArray(metadata.extraLimits) &&
				metadata.extraLimits.every((value) => {
					const limit = asRecord(value);
					return (
						limit !== undefined &&
						typeof limit.name === "string" &&
						optionalNumbers(limit, ["usedPercent", "remaining", "resetAt"])
					);
				})))
	);
}

function isPendingObservation(
	value: unknown,
): value is PendingQuotaObservation {
	const pending = asRecord(value);
	return (
		pending !== undefined &&
		isQuotaObservation(pending.observation) &&
		typeof pending.reason === "string" &&
		isFiniteNumber(pending.createdAt) &&
		isFiniteNumber(pending.updatedAt) &&
		optionalNumbers(pending, ["priorRemaining", "newRemaining", "resetAt"])
	);
}

function pruneStaleObservations(
	observations: QuotaState["observations"],
	now: number,
): QuotaState["observations"] {
	for (const key of Object.keys(observations)) {
		if (observationStale(observations[key], now)) delete observations[key];
	}
	return observations;
}

function observationStale(
	observation: QuotaState["observations"][string] | undefined,
	now: number,
): boolean {
	if (!observation) return true;
	if (observation.source === "fallback")
		return !observation.dimensions.some(
			(dimension) => dimension.resetAt !== undefined && dimension.resetAt > now,
		);
	return observation.updatedAt <= now - STALE_OBSERVATION_MS;
}

function pruneStalePending(
	pending: NonNullable<QuotaState["pendingObservations"]>,
	now: number,
): NonNullable<QuotaState["pendingObservations"]> {
	for (const key of Object.keys(pending)) {
		if (now - pending[key].createdAt > STALE_PENDING_MS) delete pending[key];
	}
	return pending;
}

export async function readJsonFile<T>(
	file: string,
	fallback: T,
): Promise<LoadResult<T>> {
	try {
		const text = await readFile(file, "utf8");
		return { path: file, value: JSON.parse(text) as T };
	} catch (error) {
		if (isCode(error, "ENOENT"))
			return { path: file, value: cloneFallback(fallback) };
		return {
			path: file,
			value: cloneFallback(fallback),
			error: errorToString(error),
		};
	}
}

export async function loadState(
	stateFile: string,
): Promise<LoadResult<QuotaState>> {
	const result = await readJsonFile<unknown>(stateFile, emptyState());
	return {
		path: stateFile,
		value: normalizeState(result.value),
		error: result.error,
	};
}

export async function writeJsonFileAtomic(
	file: string,
	value: unknown,
	options: { exclusive?: boolean } = {},
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const text = `${JSON.stringify(value, null, 2)}\n`;
	if (options.exclusive) {
		try {
			await writeFile(file, text, { encoding: "utf8", flag: "wx" });
			return;
		} catch (error) {
			if (!isCode(error, "EEXIST")) throw error;
			return;
		}
	}
	const tempFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		await writeFile(tempFile, text, "utf8");
		await rename(tempFile, file);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function mergeStateFile(
	stateFile: string,
	mutator: (
		state: QuotaState,
	) => QuotaState | void | Promise<QuotaState | void>,
): Promise<QuotaState> {
	await mkdir(dirname(stateFile), { recursive: true });
	return withFileLock(`${stateFile}.lock`, async () => {
		const current = await loadState(stateFile);
		const cloned = normalizeState(current.value);
		const next = (await mutator(cloned)) ?? cloned;
		const normalized = normalizeState(next);
		await writeJsonFileAtomic(stateFile, normalized);
		return normalized;
	});
}

async function withFileLock<T>(
	lockDir: string,
	callback: () => Promise<T>,
): Promise<T> {
	const start = Date.now();
	while (true) {
		try {
			await mkdir(lockDir, { recursive: false });
			break;
		} catch (error) {
			if (!isCode(error, "EEXIST")) throw error;
			await removeStaleLock(lockDir);
			if (Date.now() - start > LOCK_WAIT_MS)
				throw new Error(`Timed out waiting for lock: ${lockDir}`);
			await sleep(25 + Math.floor(Math.random() * 50));
		}
	}
	try {
		return await callback();
	} finally {
		await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function removeStaleLock(lockDir: string): Promise<void> {
	try {
		const info = await stat(lockDir);
		if (Date.now() - info.mtimeMs > LOCK_STALE_MS)
			await rm(lockDir, { recursive: true, force: true });
	} catch {
		// Missing or unreadable lock will be retried by the caller.
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneFallback<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

function isCode(error: unknown, code: string): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code?: string }).code === code,
	);
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
