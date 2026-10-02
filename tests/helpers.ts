import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
	PiCommandDefinition,
	PiContext,
	PiExtensionAPI,
	PiModel,
} from "../src/pi-types.js";

export type CapturedHandler = (
	event: unknown,
	ctx: PiContext,
) => void | Promise<void>;

export interface StubPi {
	api: PiExtensionAPI;
	handlers: Map<string, CapturedHandler>;
	commands: Map<string, PiCommandDefinition>;
	messages: string[];
}

export function stubPi(): StubPi {
	const handlers = new Map<string, CapturedHandler>();
	const commands = new Map<string, PiCommandDefinition>();
	const messages: string[] = [];
	return {
		api: {
			on(event, handler) {
				handlers.set(event, handler as CapturedHandler);
			},
			registerCommand(name, definition) {
				commands.set(name, definition);
			},
			sendMessage(message) {
				messages.push(message.content);
			},
		},
		handlers,
		commands,
		messages,
	};
}

export interface StubCtxOptions {
	model?: PiModel;
	modelRegistry?: Partial<PiContext["modelRegistry"]>;
	statuses?: Array<string | undefined>;
	notifications?: string[];
	onStatus?: (text: string | undefined) => void;
}

export function stubCtx(options: StubCtxOptions = {}): PiContext {
	const statuses: Array<string | undefined> = options.statuses ?? [];
	const notifications = options.notifications ?? [];
	return {
		ui: {
			theme: { fg: (_color, text) => text },
			notify(message) {
				notifications.push(message);
			},
			setStatus(_key, text) {
				statuses.push(text);
				options.onStatus?.(text);
			},
		},
		...(options.model ? { model: options.model } : {}),
		modelRegistry: options.modelRegistry ?? {},
		hasUI: true,
		mode: "tui",
	};
}

export interface FetchResponseLike {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export type FetchFixture = (
	input: string,
	init?: { headers?: Record<string, string>; signal?: unknown },
) => FetchResponseLike | Promise<FetchResponseLike>;

export interface GlobalFetchStub {
	restore(): void;
	requestedUrls: string[];
	lastInit?: { headers?: Record<string, string>; signal?: unknown };
}

export function stubGlobalFetch(fixture?: FetchFixture): GlobalFetchStub {
	const globalWithFetch = globalThis as unknown as { fetch: unknown };
	const originalFetch = globalWithFetch.fetch;
	const stubState: GlobalFetchStub = {
		restore() {
			globalWithFetch.fetch = originalFetch;
		},
		requestedUrls: [],
	};
	globalWithFetch.fetch = (async (
		input: string,
		init?: { headers?: Record<string, string>; signal?: unknown },
	) => {
		stubState.requestedUrls.push(String(input));
		stubState.lastInit = init;
		return fixture ? fixture(input, init) : { ok: true, status: 200, async json() { return {}; } };
	}) as unknown as typeof globalThis.fetch;
	return stubState;
}

export interface PendingFetchStub extends GlobalFetchStub {
	wasCalled(): Promise<void>;
	release(response: FetchResponseLike): void;
}

export function stubGlobalFetchPending(): PendingFetchStub {
	const globalWithFetch = globalThis as unknown as { fetch: unknown };
	const originalFetch = globalWithFetch.fetch;
	let release!: (response: FetchResponseLike) => void;
	const responseGate = new Promise<FetchResponseLike>((resolve) => {
		release = resolve;
	});
	let resolveFetchStarted!: () => void;
	const fetchStartedGate = new Promise<void>((resolve) => {
		resolveFetchStarted = resolve;
	});
	const stubState: PendingFetchStub = {
		restore() {
			globalWithFetch.fetch = originalFetch;
		},
		requestedUrls: [],
		wasCalled() {
			return fetchStartedGate;
		},
		release,
	};
	globalWithFetch.fetch = (async () => {
		resolveFetchStarted();
		return responseGate;
	}) as unknown as typeof globalThis.fetch;
	return stubState;
}

export function tempDirPath(): string {
	return join(
		process.cwd(),
		`.tmp-quota-status-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
}

export async function useTempQuotaDir(): Promise<{
	dir: string;
	cleanup(): Promise<void>;
}> {
	const dir = tempDirPath();
	await mkdir(dir, { recursive: true });
	const savedDir = process.env.PI_QUOTA_STATUS_DIR;
	process.env.PI_QUOTA_STATUS_DIR = dir;
	return {
		dir,
		async cleanup() {
			if (savedDir === undefined) delete process.env.PI_QUOTA_STATUS_DIR;
			else process.env.PI_QUOTA_STATUS_DIR = savedDir;
			await rm(dir, { recursive: true, force: true });
		},
	};
}
