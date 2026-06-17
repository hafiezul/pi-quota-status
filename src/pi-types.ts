export interface PiModel {
	id: string;
	provider: string;
	name?: string;
}

export interface PiTheme {
	fg(color: string, text: string): string;
}

export interface PiUi {
	theme: PiTheme;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
}

export interface PiModelRegistry {
	getAll?(): PiModel[];
	find?(provider: string, modelId: string): PiModel | undefined;
	isUsingOAuth?(model: PiModel): boolean;
	getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

export interface PiContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface PiContext {
	ui: PiUi;
	model?: PiModel;
	modelRegistry: PiModelRegistry;
	hasUI: boolean;
	mode: "tui" | "rpc" | "json" | "print" | string;
	getContextUsage?(): PiContextUsage | undefined;
}

export interface PiCommandContext extends PiContext {
	waitForIdle?(): Promise<void>;
}

export interface PiAfterProviderResponseEvent {
	status: number;
	headers: Record<string, string>;
}

export interface PiModelSelectEvent {
	model: PiModel;
	previousModel?: PiModel;
	source: "set" | "cycle" | "restore" | string;
}

export interface PiSessionStartEvent {
	reason: string;
}

export interface PiSessionShutdownEvent {
	reason: string;
}

type EventHandler<TEvent, TContext extends PiContext = PiContext> = (
	event: TEvent,
	ctx: TContext,
) => void | Promise<void>;

export interface PiCommandDefinition {
	description?: string;
	handler: (args: string, ctx: PiCommandContext) => Promise<void>;
}

export interface PiExtensionAPI {
	on(event: "session_start", handler: EventHandler<PiSessionStartEvent>): void;
	on(
		event: "session_shutdown",
		handler: EventHandler<PiSessionShutdownEvent>,
	): void;
	on(event: "model_select", handler: EventHandler<PiModelSelectEvent>): void;
	on(
		event: "after_provider_response",
		handler: EventHandler<PiAfterProviderResponseEvent>,
	): void;
	on(event: string, handler: EventHandler<unknown>): void;
	registerCommand(name: string, definition: PiCommandDefinition): void;
	sendMessage<T = unknown>(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: T;
		},
		options?: unknown,
	): void;
}
