import { parseQuotaHeaders } from "./adapters.js";
import {
	DEFAULT_CRITICAL_THRESHOLD,
	DEFAULT_WARNING_THRESHOLD,
	ensureConfigTemplate,
	loadConfig,
} from "./config.js";
import { formatCompactFooterText, formatRowsAsTable } from "./format.js";
import { getQuotaStatusPaths, type QuotaStatusPaths } from "./paths.js";
import type {
	PiAfterProviderResponseEvent,
	PiCommandContext,
	PiContext,
	PiExtensionAPI,
	PiModel,
	PiModelSelectEvent,
} from "./pi-types.js";
import {
	applySubscriptionObservation,
	buildQuotaRows,
	consumeFallbackQuota,
	getModelRef,
	observationFromParsed,
	selectFooterQuotaForModel,
	upsertObservation,
	type SubscriptionObservationApplyResult,
} from "./quota.js";
import { loadState, mergeStateFile } from "./storage.js";
import { fetchSubscriptionQuota } from "./subscription.js";
import type { ModelRef, QuotaState, QuotaStatusConfig } from "./types.js";
import { modelKey, selectAdapter } from "./match.js";

const STATUS_KEY = "pi-quota-status";
const MESSAGE_TYPE = "pi-quota-status";
const MAX_DEBUG_LINES = 20;

interface RuntimeState {
	paths: QuotaStatusPaths;
	config: QuotaStatusConfig;
	state: QuotaState;
	activeModel?: ModelRef;
	lastErrors: string[];
	debug: string[];
	refreshTimer?: unknown;
	quickRetryTimer?: unknown;
	refreshInFlight: boolean;
	sessionGeneration: number;
}

export default function quotaStatusExtension(pi: PiExtensionAPI): void {
	const runtime: RuntimeState = {
		paths: getQuotaStatusPaths(),
		config: {},
		state: { version: 1, observations: {} },
		lastErrors: [],
		debug: [],
		refreshInFlight: false,
		sessionGeneration: 0,
	};

	async function reloadFromDisk(): Promise<void> {
		runtime.paths = getQuotaStatusPaths();
		const [configResult, stateResult] = await Promise.all([
			loadConfig(runtime.paths.configFile),
			loadState(runtime.paths.stateFile),
		]);
		runtime.config = configResult.value;
		runtime.state = stateResult.value;
		runtime.lastErrors = [configResult.error, stateResult.error].filter(
			(error): error is string => Boolean(error),
		);
	}

	async function mutateState(
		mutator: (state: QuotaState) => QuotaState | void,
	): Promise<void> {
		runtime.state = await mergeStateFile(runtime.paths.stateFile, mutator);
	}

	function recordDebug(line: string): void {
		const stamp = new Date().toISOString();
		runtime.debug.unshift(`${stamp} ${line}`);
		runtime.debug = runtime.debug.slice(0, MAX_DEBUG_LINES);
	}

	function updateStatus(ctx: PiContext): void {
		const ref = runtime.activeModel ?? getModelRef(ctx.model);
		if (!ref) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (!isUsingSubscription(ctx, ref)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const selected = selectFooterQuotaForModel(
			runtime.state,
			runtime.config,
			ref,
		);
		if (!selected) {
			ctx.ui.setStatus(
				STATUS_KEY,
				formatUnavailableSubscriptionStatus(ctx, ref),
			);
			return;
		}
		const text = formatCompactFooterText(selected.segments, Date.now());
		ctx.ui.setStatus(
			STATUS_KEY,
			colorByThreshold(ctx, runtime.config, text, selected.percentRemaining),
		);
	}

	function isCurrentSession(generation: number): boolean {
		return runtime.sessionGeneration === generation;
	}

	function safeUpdateStatus(ctx: PiContext, generation: number): void {
		if (!isCurrentSession(generation)) return;
		try {
			updateStatus(ctx);
		} catch (error) {
			if (isStaleContextError(error) || !isCurrentSession(generation)) return;
			recordDebug(`status update failed: ${errorToString(error)}`);
		}
	}

	async function refreshSubscriptionQuota(
		ctx: PiContext,
		generation: number,
	): Promise<void> {
		if (!isCurrentSession(generation)) return;
		let ref: ModelRef;
		try {
			const candidate = runtime.activeModel ?? getModelRef(ctx.model);
			if (!candidate || !isUsingSubscription(ctx, candidate)) return;
			ref = candidate;
		} catch (error) {
			if (isStaleContextError(error) || !isCurrentSession(generation)) return;
			recordDebug(
				`subscription quota preflight failed: ${errorToString(error)}`,
			);
			return;
		}
		if (runtime.refreshInFlight) return;
		runtime.refreshInFlight = true;
		const now = Date.now();
		try {
			const parsed = await fetchSubscriptionQuota(ctx, ref, now);
			if (!isCurrentSession(generation) || !parsed) return;
			let applyResult: SubscriptionObservationApplyResult | undefined;
			await mutateState((state) => {
				const existing = state.observations[modelKey(ref.provider, ref.model)];
				const observation = observationFromParsed(
					ref,
					{ name: "subscription", type: "generic" },
					parsed,
					"subscription",
					200,
					now,
					existing,
				);
				applyResult = applySubscriptionObservation(state, observation, now);
			});
			if (!isCurrentSession(generation)) return;
			recordDebug(
				formatSubscriptionPollDebug(ref, parsed.dimensions.length, applyResult),
			);
			if (applyResult?.retryRecommended) scheduleQuickRetry(ctx, generation);
		} catch (error) {
			if (isStaleContextError(error) || !isCurrentSession(generation)) return;
			recordDebug(
				`${ref.provider}/${ref.model}: subscription quota poll failed: ${errorToString(error)}`,
			);
		} finally {
			runtime.refreshInFlight = false;
		}
	}

	async function refreshAndUpdateStatus(
		ctx: PiContext,
		generation: number,
	): Promise<void> {
		if (!isCurrentSession(generation)) return;
		await refreshSubscriptionQuota(ctx, generation);
		safeUpdateStatus(ctx, generation);
	}

	function refreshAndUpdateStatusInBackground(
		ctx: PiContext,
		generation: number,
	): void {
		void refreshAndUpdateStatus(ctx, generation).catch((error: unknown) => {
			if (isStaleContextError(error) || !isCurrentSession(generation)) return;
			recordDebug(`background refresh failed: ${errorToString(error)}`);
		});
	}

	function scheduleQuickRetry(ctx: PiContext, generation: number): void {
		if (runtime.quickRetryTimer || !isCurrentSession(generation)) return;
		runtime.quickRetryTimer = setTimeout(() => {
			runtime.quickRetryTimer = undefined;
			refreshAndUpdateStatusInBackground(ctx, generation);
		}, 7_500);
	}

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++runtime.sessionGeneration;
		if (runtime.refreshTimer) clearInterval(runtime.refreshTimer);
		if (runtime.quickRetryTimer) clearTimeout(runtime.quickRetryTimer);
		runtime.refreshTimer = undefined;
		runtime.quickRetryTimer = undefined;
		await reloadFromDisk();
		if (!isCurrentSession(generation)) return;
		runtime.activeModel = getModelRef(ctx.model);
		safeUpdateStatus(ctx, generation);
		await refreshAndUpdateStatus(ctx, generation);
		if (!isCurrentSession(generation)) return;
		runtime.refreshTimer = setInterval(() => {
			refreshAndUpdateStatusInBackground(ctx, generation);
		}, runtime.config.refreshIntervalMs ?? 60_000);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runtime.sessionGeneration++;
		if (runtime.refreshTimer) clearInterval(runtime.refreshTimer);
		if (runtime.quickRetryTimer) clearTimeout(runtime.quickRetryTimer);
		runtime.refreshTimer = undefined;
		runtime.quickRetryTimer = undefined;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	});

	pi.on("model_select", async (event: PiModelSelectEvent, ctx) => {
		const generation = runtime.sessionGeneration;
		runtime.activeModel = getModelRef(event.model);
		await refreshAndUpdateStatus(ctx, generation);
	});

	pi.on(
		"after_provider_response",
		async (event: PiAfterProviderResponseEvent, ctx) => {
			const generation = runtime.sessionGeneration;
			let ref: ModelRef;
			try {
				const candidate = runtime.activeModel ?? getModelRef(ctx.model);
				if (!candidate) return;
				ref = candidate;
				if (!isUsingSubscription(ctx, ref)) {
					safeUpdateStatus(ctx, generation);
					return;
				}
			} catch (error) {
				if (isStaleContextError(error) || !isCurrentSession(generation)) return;
				recordDebug(
					`provider response preflight failed: ${errorToString(error)}`,
				);
				return;
			}
			const adapter = selectAdapter(runtime.config, ref.provider, ref.model);
			if (!adapter) {
				safeUpdateStatus(ctx, generation);
				return;
			}
			const now = Date.now();
			const parsed = parseQuotaHeaders(
				event.headers,
				adapter,
				now,
				event.status,
			);
			if (parsed) {
				await mutateState((state) => {
					const existing =
						state.observations[modelKey(ref.provider, ref.model)];
					const hasFreshSubscription = existing?.dimensions.some(
						(dimension) =>
							dimension.resetAt === undefined || dimension.resetAt > now,
					);
					if (
						existing?.source === "subscription" &&
						ref.provider === "anthropic" &&
						hasFreshSubscription
					)
						return;
					const observation = observationFromParsed(
						ref,
						adapter,
						parsed,
						event.status === 429 ? "429" : "headers",
						event.status,
						now,
						existing,
					);
					upsertObservation(state, observation);
				});
				recordDebug(
					`${ref.provider}/${ref.model}: parsed ${parsed.dimensions.length} quota dimension(s), status ${event.status}`,
				);
			} else if (
				event.status >= 200 &&
				event.status < 300 &&
				adapter.fallback &&
				adapter.fallback.enabled !== false
			) {
				await mutateState((state) => {
					consumeFallbackQuota(state, runtime.config, ref, now);
				});
				recordDebug(
					`${ref.provider}/${ref.model}: no quota headers; fallback deducted after successful response`,
				);
			} else {
				recordDebug(
					`${ref.provider}/${ref.model}: no quota data for status ${event.status}`,
				);
			}
			if (!isCurrentSession(generation)) return;
			safeUpdateStatus(ctx, generation);
		},
	);

	pi.registerCommand("quota", {
		description:
			"Show quota status, config path, reload config, or debug adapter state",
		handler: async (args: string, ctx: PiCommandContext) => {
			const command = args.trim().toLowerCase();
			if (command === "" || command === "status") {
				sendMessage(pi, buildQuotaTable(runtime, ctx));
				return;
			}
			if (command === "config") {
				await handleConfigCommand(pi, runtime, ctx);
				return;
			}
			if (command === "reload") {
				const generation = runtime.sessionGeneration;
				await reloadFromDisk();
				await refreshAndUpdateStatus(ctx, generation);
				ctx.ui.notify("pi-quota-status config/state reloaded", "info");
				return;
			}
			if (command === "debug") {
				sendMessage(pi, buildDebugReport(runtime, ctx));
				return;
			}
			ctx.ui.notify(`Unknown /quota subcommand: ${command}`, "warning");
			sendMessage(pi, buildQuotaTable(runtime, ctx));
		},
	});
}

async function handleConfigCommand(
	pi: PiExtensionAPI,
	runtime: RuntimeState,
	ctx: PiCommandContext,
): Promise<void> {
	const result = await ensureConfigTemplate(runtime.paths.configFile);
	runtime.config = result.value;
	const status = result.created
		? "Created template config."
		: "Config already exists.";
	ctx.ui.notify(status, "info");
	sendMessage(
		pi,
		[
			status,
			`Config: ${runtime.paths.configFile}`,
			`State:  ${runtime.paths.stateFile}`,
			"Edit config.json, then run /quota reload.",
		].join("\n"),
	);
}

function buildQuotaTable(runtime: RuntimeState, ctx: PiContext): string {
	const models = getKnownModels(ctx);
	const rows = buildQuotaRows(
		runtime.config,
		runtime.state,
		models,
		Date.now(),
		(ref) => isUsingSubscription(ctx, ref),
	);
	if (rows.length > 0) return formatRowsAsTable(rows);
	return buildUnavailableQuotaMessage(runtime, ctx);
}

function buildDebugReport(runtime: RuntimeState, ctx: PiContext): string {
	const active = runtime.activeModel ?? getModelRef(ctx.model);
	const adapter = active
		? selectAdapter(runtime.config, active.provider, active.model)
		: undefined;
	const lines = [
		"pi-quota-status debug",
		`Config: ${runtime.paths.configFile}`,
		`State:  ${runtime.paths.stateFile}`,
		`Active model: ${active ? `${active.provider}/${active.model}` : "none"}`,
		`Matched adapter: ${adapter ? `${adapter.name ?? adapter.type ?? "generic"} (${adapter.type ?? "generic"})` : "none"}`,
		`Configured adapters: ${runtime.config.adapters?.length ?? 0}`,
		`State observations: ${Object.keys(runtime.state.observations).length}`,
		`Subscription auth: ${active ? formatSubscriptionAuth(ctx, active) : "unknown"}`,
		`Context usage: ${formatContextUsage(ctx) ?? "unknown"}`,
	];
	if (active && isUsingSubscription(ctx, active)) {
		lines.push(`Quota source: ${formatQuotaSource(runtime, active)}`);
	}
	if (runtime.lastErrors.length > 0) {
		lines.push(
			"",
			"Load errors:",
			...runtime.lastErrors.map((error) => `- ${error}`),
		);
	}
	if (runtime.debug.length > 0) {
		lines.push(
			"",
			"Recent parsed events:",
			...runtime.debug.map((line) => `- ${line}`),
		);
	}
	return lines.join("\n");
}

function colorByThreshold(
	ctx: PiContext,
	config: QuotaStatusConfig,
	text: string,
	percent: number,
): string {
	const critical = config.criticalThreshold ?? DEFAULT_CRITICAL_THRESHOLD;
	const warning = config.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
	if (percent < critical) return ctx.ui.theme.fg("error", text);
	if (percent < warning) return ctx.ui.theme.fg("warning", text);
	return text;
}

function getKnownModels(ctx: PiContext): PiModel[] {
	try {
		return ctx.modelRegistry.getAll?.() ?? [];
	} catch {
		return [];
	}
}

function buildUnavailableQuotaMessage(
	runtime: RuntimeState,
	ctx: PiContext,
): string {
	const active = runtime.activeModel ?? getModelRef(ctx.model);
	if (active && isUsingSubscription(ctx, active)) {
		const context = formatContextUsage(ctx);
		return [
			"No provider quota data for the active subscription model.",
			"Quota appears after a successful subscription poll, provider rate-limit headers, or a manual fallback.",
			context ? `Context usage: ${context}` : undefined,
		]
			.filter((line): line is string => Boolean(line))
			.join("\n");
	}
	return "No tracked quota data yet.";
}

function formatUnavailableSubscriptionStatus(
	ctx: PiContext,
	ref: ModelRef,
): string | undefined {
	if (!isUsingSubscription(ctx, ref)) return undefined;
	const context = formatContextUsage(ctx);
	return context ? `quota n/a (sub) · ctx ${context}` : "quota n/a (sub)";
}

function isUsingSubscription(ctx: PiContext, ref: ModelRef): boolean {
	const model = resolveModel(ctx, ref);
	if (!model) return false;
	try {
		return ctx.modelRegistry.isUsingOAuth?.(model) ?? false;
	} catch {
		return false;
	}
}

function formatSubscriptionAuth(ctx: PiContext, ref: ModelRef): string {
	return isUsingSubscription(ctx, ref) ? "yes" : "no";
}

function formatSubscriptionPollDebug(
	ref: ModelRef,
	dimensionCount: number,
	result: SubscriptionObservationApplyResult | undefined,
): string {
	const prefix = `${ref.provider}/${ref.model}: polled ${dimensionCount} subscription quota dimension(s)`;
	if (!result) return prefix;
	const details = [
		`action=${result.action}`,
		result.reason ? `reason=${result.reason}` : undefined,
		`5h=${formatDebugPercent(result.priorRemaining)}->${formatDebugPercent(result.newRemaining)}`,
		result.resetAt
			? `reset=${new Date(result.resetAt).toISOString()}`
			: undefined,
		`allowed=${formatDebugValue(result.metadata?.allowed)}`,
		`limit_reached=${formatDebugValue(result.metadata?.limitReached)}`,
		`rate_limit_reached_type=${formatDebugValue(result.metadata?.rateLimitReachedType)}`,
		`account_header=${result.metadata?.accountHeaderSent ? "yes" : "no"}`,
		result.metadata?.codexCliRpcFallback ? "codex_rpc=yes" : undefined,
		result.metadata?.extraLimits?.length
			? `extra_limits=${result.metadata.extraLimits
					.map(
						(limit) => `${limit.name}:${formatDebugPercent(limit.remaining)}`,
					)
					.join(",")}`
			: undefined,
	].filter((part): part is string => Boolean(part));
	return `${prefix}; ${details.join("; ")}`;
}

function formatDebugPercent(value: number | undefined): string {
	return value === undefined || Number.isNaN(value)
		? "unknown"
		: `${Math.floor(value)}%`;
}

function formatDebugValue(value: unknown): string {
	if (value === undefined) return "unknown";
	if (value === null) return "null";
	return String(value);
}

function formatQuotaSource(runtime: RuntimeState, ref: ModelRef): string {
	const observation =
		runtime.state.observations[modelKey(ref.provider, ref.model)];
	switch (observation?.source) {
		case "subscription":
			return "subscription poll";
		case "headers":
			return "provider headers";
		case "429":
			return "provider 429 response";
		case "fallback":
			return "manual fallback estimate";
		default:
			return "pending subscription poll, provider headers, or fallback";
	}
}

function resolveModel(ctx: PiContext, ref: ModelRef): PiModel | undefined {
	if (ctx.model?.provider === ref.provider && ctx.model.id === ref.model)
		return ctx.model;
	try {
		return ctx.modelRegistry.find?.(ref.provider, ref.model);
	} catch {
		return undefined;
	}
}

function formatContextUsage(ctx: PiContext): string | undefined {
	const usage = ctx.getContextUsage?.();
	if (!usage || usage.contextWindow <= 0) return undefined;
	const percent = usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`;
	return `${percent}/${formatTokenCount(usage.contextWindow)}`;
}

function formatTokenCount(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const abs = Math.abs(value);
	if (abs >= 1_000_000) return `${trimDecimal(value / 1_000_000)}m`;
	if (abs >= 1_000) return `${Math.round(value / 1_000)}k`;
	return `${Math.round(value)}`;
}

function trimDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error && error.message.includes("extension ctx is stale")
	);
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sendMessage(pi: PiExtensionAPI, content: string): void {
	pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true });
}
