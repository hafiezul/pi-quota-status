import { spawn } from "node:child_process";
import { CODEX_SHORT_WINDOW, CODEX_WEEKLY_WINDOW } from "./codex-policy.js";
import { clampPercent } from "./format.js";
import {
	normalizedDimensionName,
	type QuotaDimensionLike,
} from "./quota-dimensions.js";
import {
	asRecord,
	firstDefined,
	nullableStringValue,
	numberValue,
	stringValue,
	timestampValue,
} from "./parse-utils.js";
import type { ParsedQuotaDimension, ParsedQuotaObservation } from "./types.js";

const CODEX_RPC_ARGS = ["-s", "read-only", "-a", "untrusted", "app-server"];
const INIT_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 3_000;
const SESSION_WINDOW_MINUTES = 5 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

type CodexWindowName = typeof CODEX_SHORT_WINDOW | typeof CODEX_WEEKLY_WINDOW;

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export async function fetchCodexCliRateLimits(
	now = Date.now(),
): Promise<ParsedQuotaObservation | undefined> {
	const client = new CodexRpcClient();
	try {
		await client.initialize();
		const result = await client.request("account/rateLimits/read");
		return parseCodexCliRateLimitsResult(result, now);
	} catch {
		return undefined;
	} finally {
		client.shutdown();
	}
}

export function parseCodexCliRateLimitsResult(
	value: unknown,
	_now = Date.now(),
): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const result = asRecord(root?.result) ?? root;
	const rateLimits =
		asRecord(result?.rateLimits) ?? asRecord(result?.rate_limits);
	if (!rateLimits) return undefined;
	const dimensions = sortCodexDimensions(
		uniqueDimensionsByName(
			[
				parseRpcWindow(rateLimits.primary, CODEX_SHORT_WINDOW),
				parseRpcWindow(rateLimits.secondary, CODEX_WEEKLY_WINDOW),
			].filter((dimension): dimension is ParsedQuotaDimension =>
				Boolean(dimension),
			),
		),
	);
	if (dimensions.length === 0) return undefined;
	const rateLimitReachedType = nullableStringValue(
		firstDefined(
			rateLimits.rateLimitReachedType,
			rateLimits.rate_limit_reached_type,
		),
	);
	return {
		dimensions,
		metadata: {
			...(rateLimitReachedType !== undefined ? { rateLimitReachedType } : {}),
		},
	};
}

class CodexRpcClient {
	private child = spawn("codex", CODEX_RPC_ARGS, {
		stdio: ["pipe", "pipe", "pipe"],
		env: process.env,
	});
	private buffer = "";
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private closed = false;

	constructor() {
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => {
			this.handleStdout(chunk);
		});
		this.child.stderr.resume();
		this.child.on("error", (error: Error) => {
			this.rejectAll(error);
		});
		this.child.on("close", () => {
			this.closed = true;
			this.rejectAll(new Error("codex app-server closed"));
		});
	}

	async initialize(): Promise<void> {
		await this.request(
			"initialize",
			{ clientInfo: { name: "pi-quota-status", version: "0.0.0" } },
			INIT_TIMEOUT_MS,
		);
		this.notify("initialized");
	}

	request(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<unknown> {
		if (this.closed)
			return Promise.reject(new Error("codex app-server closed"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`codex RPC timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ id, method, params }, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(error);
			});
		});
	}

	shutdown(): void {
		this.rejectAll(new Error("codex RPC shut down"));
		if (!this.child.killed) this.child.kill();
	}

	private notify(method: string, params: Record<string, unknown> = {}): void {
		this.write({ method, params });
	}

	private write(
		payload: Record<string, unknown>,
		callback?: (error?: Error | null) => void,
	): void {
		try {
			this.child.stdin.write(`${JSON.stringify(payload)}\n`, callback);
		} catch (error) {
			callback?.(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private handleStdout(chunk: string): void {
		this.buffer += chunk;
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			this.handleLine(line);
			newlineIndex = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		if (!line) return;
		const message = asRecord(safeJsonParse(line));
		if (!message) return;
		const id = numberValue(message.id);
		if (id === undefined) return;
		const pending = this.pending.get(id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(id);
		const error = asRecord(message.error);
		if (error) {
			pending.reject(
				new Error(stringValue(error.message) ?? "codex RPC request failed"),
			);
			return;
		}
		pending.resolve(message.result);
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(error);
		}
	}
}

function parseRpcWindow(
	value: unknown,
	fallbackName: CodexWindowName,
): ParsedQuotaDimension | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const usedPercent = numberValue(
		record.usedPercent ?? record.used_percent ?? record.used,
	);
	if (usedPercent === undefined) return undefined;
	const windowDurationMins = numberValue(
		record.windowDurationMins ??
			record.window_duration_mins ??
			record.window_minutes ??
			record.windowMinutes,
	);
	return {
		name: dimensionNameForWindow(windowDurationMins, fallbackName),
		limit: 100,
		remaining: clampPercent(100 - usedPercent),
		resetAt: timestampValue(record.resetsAt ?? record.resets_at),
	};
}

function dimensionNameForWindow(
	windowDurationMins: number | undefined,
	fallbackName: CodexWindowName,
): CodexWindowName {
	if (windowDurationMins === SESSION_WINDOW_MINUTES) return CODEX_SHORT_WINDOW;
	if (windowDurationMins === WEEKLY_WINDOW_MINUTES) return CODEX_WEEKLY_WINDOW;
	return fallbackName;
}

function uniqueDimensionsByName<T extends QuotaDimensionLike>(
	dimensions: T[],
): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const dimension of dimensions) {
		const key = normalizedDimensionName(dimension.name);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(dimension);
	}
	return result;
}

function sortCodexDimensions(
	dimensions: ParsedQuotaDimension[],
): ParsedQuotaDimension[] {
	const order = new Map([
		[CODEX_SHORT_WINDOW, 0],
		[CODEX_WEEKLY_WINDOW, 1],
	]);
	return [...dimensions].sort(
		(left, right) =>
			(order.get(normalizedDimensionName(left.name)) ?? 100) -
			(order.get(normalizedDimensionName(right.name)) ?? 100),
	);
}

function safeJsonParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}
