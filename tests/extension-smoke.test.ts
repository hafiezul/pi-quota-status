import test from "node:test";
import assert from "node:assert/strict";
import quotaStatusExtension from "../src/index.js";
import type { PiCommandDefinition, PiExtensionAPI } from "../src/pi-types.js";

test("extension registers expected events and /quota command", () => {
	const events: string[] = [];
	const commands = new Map<string, PiCommandDefinition>();
	const pi: PiExtensionAPI = {
		on(event: string) {
			events.push(event);
		},
		registerCommand(name: string, definition: PiCommandDefinition) {
			commands.set(name, definition);
		},
		sendMessage() {
			// no-op
		},
	};
	quotaStatusExtension(pi);
	assert.deepEqual(events, [
		"session_start",
		"session_shutdown",
		"model_select",
		"after_provider_response",
	]);
	assert.ok(commands.has("quota"));
});

test("/quota status is accepted as table alias", async () => {
	const commands = new Map<string, PiCommandDefinition>();
	const messages: string[] = [];
	const notifications: string[] = [];
	const pi: PiExtensionAPI = {
		on() {
			// no-op
		},
		registerCommand(name: string, definition: PiCommandDefinition) {
			commands.set(name, definition);
		},
		sendMessage(message) {
			messages.push(message.content);
		},
	};
	quotaStatusExtension(pi);

	await commands.get("quota")?.handler("status", {
		ui: {
			theme: { fg: (_color, text) => text },
			notify(message) {
				notifications.push(message);
			},
			setStatus() {
				// no-op
			},
		},
		modelRegistry: {},
		hasUI: true,
		mode: "tui",
	});

	assert.deepEqual(notifications, []);
	assert.deepEqual(messages, ["No tracked quota data yet."]);
});

test("/quota status explains subscription quota unavailability", async () => {
	const commands = new Map<string, PiCommandDefinition>();
	const messages: string[] = [];
	const model = { provider: "openai-codex", id: "gpt-5.5" };
	const pi: PiExtensionAPI = {
		on() {
			// no-op
		},
		registerCommand(name: string, definition: PiCommandDefinition) {
			commands.set(name, definition);
		},
		sendMessage(message) {
			messages.push(message.content);
		},
	};
	quotaStatusExtension(pi);

	await commands.get("quota")?.handler("status", {
		ui: {
			theme: { fg: (_color, text) => text },
			notify() {
				// no-op
			},
			setStatus() {
				// no-op
			},
		},
		model,
		modelRegistry: {
			isUsingOAuth(candidate) {
				return candidate === model;
			},
		},
		hasUI: true,
		mode: "tui",
		getContextUsage() {
			return { tokens: 12_784, contextWindow: 272_000, percent: 4.7 };
		},
	});

	assert.ok(/No provider quota data/.test(messages[0] ?? ""));
	assert.ok(/Context usage: 4\.7%\/272k/.test(messages[0] ?? ""));
});
