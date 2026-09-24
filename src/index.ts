import { parseQuotaHeaders } from "./adapters.js";
import {
	DEFAULT_CONFIG,
	DEFAULT_CRITICAL_THRESHOLD,
	DEFAULT_WARNING_THRESHOLD,
	ensureConfigTemplate,
	loadConfig,
} from "./config.js";
import {
	formatCompactFooterText,
	formatProviderMetric,
	formatRowsAsTable,
} from "./format.js";
import { getQuotaStatusPaths, type QuotaStatusPaths } from "./paths.js";
import {
	fetchProviderQuota,
	getProviderQuotaPollerName,
} from "./provider-quota.js";
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
	selectProviderMetricsForModel,
	upsertObservation,
	type SubscriptionObservationApplyResult,
} from "./quota.js";
import { loadState, mergeStateFile } from "./storage.js";
import {
	fetchSubscriptionQuota,
	supportsSubscriptionQuotaProvider,
} from "./subscription.js";
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
		config: DEFAULT_CONFIG,
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
		const selected = selectFooterQuotaForModel(
			runtime.state,
			runtime.config,
			ref,
		);
		if (!selected) {
			const metrics = selectProviderMetricsForModel(
				runtime.state,
				runtime.config,
				ref,
			);
			if (metrics.length > 0) {
				ctx.ui.setStatus(
					STATUS_KEY,
					metrics.map(formatProviderMetric).join(" · "),
				);
				return;
			}
			ctx.ui.setStatus(
				STATUS_KEY,
				formatUnavailableStatus(runtime.config, ctx, ref),
			);
			return;
		}
		const quotaText = formatCompactFooterText(selected.segments, Date.now());
		const coloredQuota = colorByThreshold(
			ctx,
			runtime.config,
			quotaText,
			selected.percentRemaining,
		);
		ctx.ui.setStatus(STATUS_KEY, coloredQuota);
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

	async function refreshQuota(
		ctx: PiContext,
		generation: number,
	): Promise<void> {
		if (!isCurrentSession(generation)) return;
		let ref: ModelRef;
		let subscriptionPoll: boolean;
		try {
			const candidate = runtime.activeModel ?? getModelRef(ctx.model);
			if (!candidate) return;
			ref = candidate;
			subscriptionPoll = shouldPollSubscriptionQuota(ctx, candidate);
		} catch (error) {
			if (isStaleContextError(error) || !isCurrentSession(generation)) return;
			recordDebug(
				`quota preflight failed: ${errorToString(error)}`,
			);
			return;
		}
		if (runtime.refreshInFlight) return;
		runtime.refreshInFlight = true;
		const now = Date.now();
		try {
			if (subscriptionPoll) {
				try {
					const parsed = await fetchSubscriptionQuota(ctx, ref, now);
					if (!isCurrentSession(generation)) return;
					if (parsed) {
						let applyResult: SubscriptionObservationApplyResult | undefined;
						await mutateState((state) => {
							const existing =
								state.observations[modelKey(ref.provider, ref.model)];
							const observation = observationFromParsed(
								ref,
								{ name: "subscription", type: "generic" },
								parsed,
								"subscription",
								200,
								now,
								existing,
							);
							applyResult = applySubscriptionObservation(
								state,
								observation,
								now,
							);
						});
						recordDebug(
							formatSubscriptionPollDebug(
								ref,
								parsed.dimensions.length,
								applyResult,
							),
						);
						if (applyResult?.retryRecommended)
							scheduleQuickRetry(ctx, generation);
						return;
					}
				} catch (error) {
					if (isStaleContextError(error) || !isCurrentSession(generation)) return;
					recordDebug(
						`${ref.provider}/${ref.model}: native subscription poll failed: ${errorToString(error)}`,
					);
				}
			}

			const providerQuota = await fetchProviderQuota(ctx, ref, now);
			if (!isCurrentSession(generation) || !providerQuota) return;
			await mutateState((state) => {
				const existing = state.observations[modelKey(ref.provider, ref.model)];
				upsertObservation(
					state,
					observationFromParsed(
						ref,
						{ name: `provider:${providerQuota.poller}`, type: "generic" },
						providerQuota.parsed,
						"provider",
						200,
						now,
						existing,
					),
				);
			});
			recordDebug(
				`${ref.provider}/${ref.model}: native ${providerQuota.poller} poll returned ${providerQuota.parsed.dimensions.length} quota dimension(s)`,
			);
		} catch (error) {
			if (isStaleContextError(error) || !isCurrentSession(generation)) return;
			recordDebug(
				`${ref.provider}/${ref.model}: quota poll failed: ${errorToString(error)}`,
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
		await refreshQuota(ctx, generation);
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
		refreshAndUpdateStatusInBackground(ctx, generation);
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
	const rows = buildQuotaRows(runtime.config, runtime.state, models, Date.now());
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
		`OAuth auth: ${active ? formatOAuthAuth(ctx, active) : "unknown"}`,
		`Subscription-backed: ${active ? (isSubscriptionBacked(ctx, active) ? "yes" : "no") : "unknown"}`,
		`Native provider poller: ${active ? (getProviderQuotaPollerName(active.provider) ?? "none") : "unknown"}`,
	];
	if (active && shouldPollSubscriptionQuota(ctx, active)) {
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
	if (!active) return "No tracked quota data yet.";
	const subscription = isSubscriptionBacked(ctx, active);
	const providerPoller = getProviderQuotaPollerName(active.provider);
	const adapter = selectAdapter(runtime.config, active.provider, active.model);
	if (!subscription && !providerPoller && !adapter)
		return "No tracked quota data yet.";
	return [
		"No provider quota data for the active model.",
		"Quota appears after a native provider poll, provider rate-limit headers, or a manual fallback.",
	].join("\n");
}

function formatUnavailableStatus(
	config: QuotaStatusConfig,
	ctx: PiContext,
	ref: ModelRef,
): string | undefined {
	const subscription = isSubscriptionBacked(ctx, ref);
	const hasQuotaSource =
		subscription ||
		Boolean(getProviderQuotaPollerName(ref.provider)) ||
		Boolean(selectAdapter(config, ref.provider, ref.model));
	const quota = hasQuotaSource
		? subscription
			? "quota n/a (sub)"
			: "quota n/a"
		: undefined;
	return quota;
}

function isUsingOAuth(ctx: PiContext, ref: ModelRef): boolean {
	const model = resolveModel(ctx, ref);
	if (!model) return false;
	try {
		return ctx.modelRegistry.isUsingOAuth?.(model) ?? false;
	} catch {
		return false;
	}
}

function isSubscriptionBacked(ctx: PiContext, ref: ModelRef): boolean {
	if (ref.provider === "kimi-coding") return true;
	if (!isUsingOAuth(ctx, ref)) return false;
	try {
		const declared =
			ctx.modelRegistry.getProvider?.(ref.provider)?.auth?.oauth?.isSubscription;
		if (typeof declared === "boolean") return declared;
	} catch {
		// Fall through to known native subscription providers.
	}
	return supportsSubscriptionQuotaProvider(ref.provider);
}

function shouldPollSubscriptionQuota(ctx: PiContext, ref: ModelRef): boolean {
	return supportsSubscriptionQuotaProvider(ref.provider) && isUsingOAuth(ctx, ref);
}

function formatOAuthAuth(ctx: PiContext, ref: ModelRef): string {
	return isUsingOAuth(ctx, ref) ? "yes" : "no";
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
		case "provider":
			return "native provider poll";
		case "codexbar":
			return "legacy CodexBar observation";
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
