declare const process: {
	pid: number;
	env: Record<string, string | undefined>;
	cwd(): string;
};

declare const Buffer: {
	from(
		input: string,
		encoding: "base64",
	): { toString(encoding: "utf8"): string };
};

declare function setTimeout(
	handler: (...args: unknown[]) => void,
	timeout?: number,
	...args: unknown[]
): unknown;
declare function clearTimeout(timeoutId: unknown): void;
declare function setInterval(
	handler: (...args: unknown[]) => void,
	timeout?: number,
	...args: unknown[]
): unknown;
declare function clearInterval(intervalId: unknown): void;

type AbortSignal = {};

declare class AbortController {
	readonly signal: AbortSignal;
	abort(): void;
}

declare const fetch: (
	input: string,
	init?: {
		headers?: Record<string, string>;
		signal?: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

declare module "node:os" {
	export function homedir(): string;
}

declare module "node:path" {
	export function join(...paths: string[]): string;
	export function dirname(path: string): string;
}

declare module "node:fs" {
	export function existsSync(path: string): boolean;
}

declare module "node:child_process" {
	export interface ChildProcess {
		stdin: {
			write(data: string, callback?: (error?: Error | null) => void): boolean;
		};
		stdout: {
			setEncoding(encoding: "utf8"): void;
			on(event: "data", listener: (chunk: string) => void): unknown;
		};
		stderr: { resume(): void };
		killed: boolean;
		kill(signal?: string): boolean;
		on(event: "error", listener: (error: Error) => void): unknown;
		on(
			event: "close",
			listener: (code: number | null, signal: string | null) => void,
		): unknown;
	}
	export function spawn(
		command: string,
		args?: string[],
		options?: { stdio?: string[]; env?: Record<string, string | undefined> },
	): ChildProcess;
}

declare module "node:fs/promises" {
	export function mkdir(
		path: string,
		options?: { recursive?: boolean },
	): Promise<void>;
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
	export function writeFile(
		path: string,
		data: string,
		options?: string | { encoding?: string; flag?: string },
	): Promise<void>;
	export function rename(oldPath: string, newPath: string): Promise<void>;
	export function rm(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void>;
	export interface Stats {
		mtimeMs: number;
	}
	export const stat: (path: string) => Promise<Stats>;
}

declare module "node:test" {
	type TestFunction = (name: string, fn: () => void | Promise<void>) => void;
	const test: TestFunction;
	export default test;
	export { test };
}

declare module "node:assert/strict" {
	interface AssertStrict {
		equal(actual: unknown, expected: unknown, message?: string): void;
		deepEqual(actual: unknown, expected: unknown, message?: string): void;
		ok(value: unknown, message?: string): void;
	}
	const assert: AssertStrict;
	export default assert;
}
