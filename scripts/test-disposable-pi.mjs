import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = JSON.parse(await readFile(join(repo, "tests/fixtures/providers.json"), "utf8"));
const cli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const filter = process.argv[2];
const cases = fixtures.cases.filter((fixture) => !filter || fixture.name === filter);
assert.ok(cases.length > 0, "No matching provider fixture");
const report = {
	kind: "synthetic HTTP fixtures in real Pi",
	sources: fixtures.sources,
	cases: [],
	inferenceRequests: 0,
};
await mkdir(join(repo, ".tmp-test"), { recursive: true });

function materialize(value, now) {
	if (Array.isArray(value)) return value.map((item) => materialize(item, now));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, materialize(item, now)]),
		);
	if (typeof value !== "string") return value;
	const match = /^@(time|ms|sec):(-?\d+)$/.exec(value);
	if (!match) return value;
	const timestamp = now + Number(match[2]) * 1000;
	return match[1] === "time"
		? new Date(timestamp).toISOString()
		: match[1] === "ms"
			? timestamp
			: Math.floor(timestamp / 1000);
}

class PiClient {
	constructor(child) {
		this.child = child;
		this.events = [];
		this.pending = new Map();
		this.sequence = 0;
		this.stderr = "";
		child.stderr.on("data", (chunk) => {
			this.stderr += chunk;
		});
		this.lines = createInterface({ input: child.stdout });
		this.lines.on("line", (line) => {
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			this.events.push(event);
			if (event.type === "response") this.pending.get(event.id)?.(event);
		});
	}

	async call(type, args = {}) {
		if (type === "prompt")
			assert.ok(
				[
					"/quota",
					"/quota status",
					"/quota debug",
					"/quota config",
					"/quota reload",
					"/verify-stop",
				].includes(args.message),
			);
		const id = String(++this.sequence);
		let timer;
		try {
			const response = await new Promise((resolveRequest, reject) => {
				this.pending.set(id, resolveRequest);
				timer = setTimeout(
					() => reject(new Error(`Pi RPC timed out: ${type}; ${this.stderr.slice(-1500)}`)),
					15_000,
				);
				this.child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
			});
			assert.equal(response.success, true, JSON.stringify(response));
			if (type === "prompt" && args.message !== "/verify-stop")
				assert.equal(
					response.data.disposition,
					"handled",
					"A quota command must never start an agent turn",
				);
			return response.data;
		} finally {
			clearTimeout(timer);
			this.pending.delete(id);
		}
	}

	statuses() {
		return this.events.filter(
			(event) => event.method === "setStatus" && event.statusKey === "pi-quota-status",
		);
	}
}

async function until(condition) {
	const deadline = Date.now() + 5_000;
	do {
		if (await condition()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	} while (Date.now() < deadline);
	throw new Error("Timed out waiting for the real Pi observation");
}

async function readObservation(root, key) {
	try {
		return JSON.parse(await readFile(join(root, "quota/state.json"), "utf8")).observations[key];
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

function checkObservation(observation, fixture) {
	assert.ok(observation, "Quota was not persisted");
	assert.deepEqual(
		observation.dimensions.map((dimension, index) => ({
			name: dimension.name,
			limit: dimension.limit,
			remaining: dimension.remaining,
			...(fixture.expected.dimensions[index]?.resetAt !== undefined
				? { resetAt: dimension.resetAt }
				: {}),
		})),
		fixture.expected.dimensions,
	);
	assert.deepEqual(
		(observation.metrics ?? []).map(({ name, value, unit }) => ({ name, value, unit })),
		fixture.expected.metrics,
	);
}

async function runCase(original) {
	const root = await mkdtemp(join(tmpdir(), "pi-quota-fixture-"));
	const fixture = materialize(original, Math.floor(Date.now() / 1000) * 1000);
	const key = `${fixture.provider}/${fixture.model}`;
	const result = {
		name: fixture.name,
		provider: fixture.provider,
		source: fixtures.sources[fixture.source],
		checks: [],
	};
	let child;
	try {
		await mkdir(join(root, "agent"), { mode: 0o700 });
		await mkdir(join(root, "project"));
		await mkdir(join(root, "quota"));
		await cp(join(repo, "src"), join(root, "extension/src"), { recursive: true });
		await cp(join(repo, "package.json"), join(root, "extension/package.json"));
		await cp(join(repo, "tests/fixtures/provider-http.mjs"), join(root, "provider-http.mjs"));
		await writeFile(join(root, "case.json"), JSON.stringify(fixture));
		const control = join(root, "control.json");
		await writeFile(control, JSON.stringify({ mode: "healthy" }));
		const token =
			fixture.provider === "antigravity"
				? JSON.stringify({ token: "fixture-token", projectId: "fixture-project" })
				: "fixture-token";
		const auth =
			fixture.auth === "oauth"
				? {
						type: "oauth",
						access: token,
						refresh: "fixture-refresh-never-used",
						expires: 4102444800000,
					}
				: { type: "api_key", key: token };
		await writeFile(join(root, "agent/auth.json"), JSON.stringify({ [fixture.provider]: auth }), {
			mode: 0o600,
		});
		const provider = {
			baseUrl: fixture.baseUrl,
			api: "openai-completions",
			models: [{ id: fixture.model, name: "Quota fixture" }],
		};
		if (fixture.auth !== "oauth") provider.apiKey = token;
		await writeFile(
			join(root, "agent/models.json"),
			JSON.stringify({ providers: { [fixture.provider]: provider } }),
		);
		await writeFile(join(root, "agent/settings.json"), JSON.stringify({ quietStartup: true }));
		await writeFile(
			join(root, "safety.ts"),
			`
import { installFixtureFetch } from "./provider-http.mjs";
export default function (pi) {
  installFixtureFetch();
  pi.on("input", () => ({ action: "handled" }));
  pi.registerCommand("verify-stop", { handler: async (_args, ctx) => { ctx.shutdown(); } });
}
`,
		);
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PI_QUOTA_STATUS_DIR: join(root, "quota"),
			CODEX_HOME: join(root, "codex"),
			PI_TELEMETRY: "0",
			PI_OFFLINE: "1",
			PI_QUOTA_TEST_CASE: join(root, "case.json"),
			PI_QUOTA_TEST_CONTROL: control,
			PI_QUOTA_TEST_REQUESTS: join(root, "requests.jsonl"),
		};
		for (const name of Object.keys(env))
			if (
				/(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(name) ||
				[
					"FIREWORKS_ACCOUNT_SLUG",
					"GROQ_API_URL",
					"COMMAND_CODE_API_BASE",
					"COMMANDCODE_API_BASE",
					"NODE_OPTIONS",
				].includes(name)
			)
				delete env[name];
		child = spawn(
			process.execPath,
			[
				cli,
				"--mode",
				"rpc",
				"--no-session",
				"--offline",
				"--no-extensions",
				"-e",
				join(root, "safety.ts"),
				"-e",
				join(root, "extension/src/index.ts"),
				"--no-mcp",
				"--no-tools",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-approve",
				"--provider",
				fixture.provider,
				"--model",
				fixture.model,
			],
			{ cwd: join(root, "project"), env, stdio: ["pipe", "pipe", "pipe"] },
		);
		const exited = once(child, "exit");
		const pi = new PiClient(child);
		const { commands } = await pi.call("get_commands");
		assert.ok(commands.some((command) => command.name === "quota"));
		const state = await pi.call("get_state");
		assert.equal(state.model.provider, fixture.provider);
		assert.equal(state.model.id, fixture.model);
		assert.equal(state.isStreaming, false);
		await until(async () => Boolean(await readObservation(root, key)));
		checkObservation(await readObservation(root, key), fixture);
		for (const text of fixture.expected.footer)
			assert.ok(
				pi.statuses().some((event) => event.statusText?.includes(text)),
				`Missing footer segment ${text}`,
			);
		result.checks.push("startup poll, exact normalized values, persistence and footer");
		await pi.call("prompt", { message: "/quota config" });
		await pi.call("prompt", { message: "/quota status" });
		const { messages } = await pi.call("get_messages");
		assert.ok(
			messages.some(
				(message) =>
					message.customType === "pi-quota-status" && String(message.content).includes(key),
			),
		);
		result.checks.push("quota commands and table");
		for (const mode of [
			"http-401",
			"http-429",
			"http-503",
			"invalid-json",
			"invalid-shape",
			"network-error",
			...(fixture.provider === "groq" ? ["overflow"] : []),
		]) {
			const prior = await readObservation(root, key);
			await writeFile(control, JSON.stringify({ mode }));
			await pi.call("prompt", { message: "/quota reload" });
			assert.deepEqual(
				await readObservation(root, key),
				prior,
				`${mode} must preserve trusted quota`,
			);
			assert.equal((await pi.call("get_state")).isStreaming, false);
			result.checks.push(`${mode} retains trusted quota`);
		}
		for (const mode of [
			"healthy",
			...(["antigravity", "minimax", "minimax-cn"].includes(fixture.provider) ? ["fallback"] : []),
		]) {
			await writeFile(control, JSON.stringify({ mode }));
			await pi.call("prompt", { message: "/quota reload" });
			checkObservation(await readObservation(root, key), fixture);
			result.checks.push(
				mode === "healthy" ? "recovery after errors" : "alternate endpoint fallback",
			);
		}
		if (fixture.provider === "huggingface") {
			await writeFile(control, JSON.stringify({ mode: "optional-unavailable" }));
			await pi.call("prompt", { message: "/quota reload" });
			const observation = await readObservation(root, key);
			assert.deepEqual(observation.dimensions, []);
			assert.equal(observation.metrics[0].value, 0.45);
			assert.ok(pi.statuses().at(-1).statusText.includes("$0.45"));
			result.checks.push("optional GPU failure preserves billing");
		}
		const finalMessages = (await pi.call("get_messages")).messages;
		assert.ok(finalMessages.every((message) => !["user", "assistant"].includes(message.role)));
		assert.ok(!pi.events.some((event) => event.type === "agent_start"));
		await pi.call("prompt", { message: "/verify-stop" });
		const [code] = await Promise.race([
			exited,
			new Promise((_, reject) => {
				const timer = setTimeout(() => reject(new Error("Shutdown timed out")), 5_000);
				timer.unref();
			}),
		]);
		assert.equal(code, 0);
		assert.equal(pi.statuses().at(-1).statusText, undefined);
		const requests = (await readFile(join(root, "requests.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.ok(
			requests.length > 0 && requests.every((request) => request.matched),
			"Unexpected request attempted",
		);
		result.requestCount = requests.length;
		result.checks.push("no inference, no unmatched network requests, clean shutdown");
		result.passed = true;
	} catch (error) {
		result.passed = false;
		result.error = error.message;
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			const killed = setTimeout(() => child.kill("SIGKILL"), 2_000);
			await exited;
			clearTimeout(killed);
		}
		await rm(root, { recursive: true, force: true });
		result.disposableProfileRemoved = true;
	}
	return result;
}

for (const fixture of cases) {
	const result = await runCase(fixture);
	report.cases.push(result);
	console.log(
		`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.error ?? result.checks.length + " checks"}`,
	);
}
report.passed = report.cases.every((result) => result.passed);
await writeFile(
	join(repo, ".tmp-test/provider-integration-report.json"),
	`${JSON.stringify(report, null, 2)}\n`,
);
process.exitCode = report.passed ? 0 : 1;
