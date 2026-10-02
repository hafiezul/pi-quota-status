import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useTempQuotaDir } from "./helpers.js";

test("extension timers unref so a host can exit without session_shutdown", async () => {
	const storage = await useTempQuotaDir();
	try {
		await writeFile(
			join(storage.dir, "config.json"),
			JSON.stringify({
				refreshIntervalMs: 60_000,
				adapters: [
					{
						name: "anthropic",
						type: "anthropic",
						provider: "anthropic",
						models: ["claude-*"],
					},
				],
			}),
		);
		const probe = `
			const { default: quotaStatusExtension } = await import(${JSON.stringify(join(process.cwd(), ".tmp-test/src/index.js"))});
			const handlers = new Map();
			quotaStatusExtension({
				on(event, handler) { handlers.set(event, handler); },
				registerCommand() {},
				sendMessage() {},
			});
			const model = { provider: "anthropic", id: "claude-sonnet-4" };
			process.env.PI_QUOTA_STATUS_DIR = ${JSON.stringify(storage.dir)};
			await handlers.get("session_start")(
				{ reason: "probe" },
				{
					ui: {
						theme: { fg: (_color, text) => text },
						notify() {},
						setStatus() {},
					},
					model,
					modelRegistry: {
						isUsingOAuth() { return true; },
						async getApiKeyForProvider() { return "oauth-token"; },
					},
					hasUI: true,
					mode: "tui",
				},
			);
			console.log("probe-ok");
		`;
		const started = Date.now();
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
			timeout: 5_000,
			env: { ...process.env },
		});
		const elapsedMs = Date.now() - started;
		assert.ok(
			result.status === 0,
			`subprocess exited with status ${result.status}; a ref'd timer makes spawnSync kill it on timeout`,
		);
		assert.ok(
			elapsedMs < 4_000,
			`subprocess exits naturally without open handles, took ${elapsedMs}ms`,
		);
		assert.equal(result.stdout.toString().trim(), "probe-ok");
	} finally {
		await storage.cleanup();
	}
});
