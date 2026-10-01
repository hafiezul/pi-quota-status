import { dirname } from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { LoadResult, QuotaState } from "./types.js";

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const STALE_OBSERVATION_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_PENDING_MS = 24 * 60 * 60 * 1000;

export function emptyState(): QuotaState {
	return { version: 1, observations: {} };
}

export function normalizeState(value: unknown, now = Date.now()): QuotaState {
	if (!value || typeof value !== "object") return emptyState();
	const maybe = value as Partial<QuotaState>;
	const observations =
		maybe.observations && typeof maybe.observations === "object"
			? pruneStaleObservations({ ...maybe. observations }, now)
			: {};
	const pendingObservations =
		maybe.pendingObservations && typeof maybe.pendingObservations === "object"
			? pruneStalePending(
					{
						...maybe.pendingObservations,
					} as NonNullable<QuotaState["pendingObservations"]>,
					now,
			  )
			: undefined;
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
	const updatedAt = observation.updatedAt as unknown;
	return typeof updatedAt !== "number" || updatedAt <= now - STALE_OBSERVATION_MS;
}

function pruneStalePending(
	pending: NonNullable<QuotaState["pendingObservations"]>,
	now: number,
): NonNullable<QuotaState["pendingObservations"]> {
	for (const key of Object.keys(pending)) {
		const entry = pending[key] as unknown;
		const createdAt =
			entry && typeof entry === "object" && "createdAt" in entry
				? (entry as { createdAt?: unknown }).createdAt
				: undefined;
		if (
			typeof createdAt !== "number" ||
			now - createdAt > STALE_PENDING_MS
		)
			delete pending[key];
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
