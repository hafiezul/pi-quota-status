import type { AdapterConfig, ModelRef, QuotaStatusConfig } from "./types.js";

export function matchesGlob(value: string, glob: string | undefined): boolean {
	const text = value.toLowerCase();
	const pattern = (glob || "*").toLowerCase();
	let textIndex = 0;
	let patternIndex = 0;
	let starIndex = -1;
	let matchIndex = 0;

	while (textIndex < text.length) {
		const patternChar = pattern[patternIndex];
		const textChar = text[textIndex];
		if (patternChar === "?" || patternChar === textChar) {
			textIndex++;
			patternIndex++;
			continue;
		}
		if (patternChar === "*") {
			starIndex = patternIndex;
			matchIndex = textIndex;
			patternIndex++;
			continue;
		}
		if (starIndex !== -1) {
			patternIndex = starIndex + 1;
			matchIndex++;
			textIndex = matchIndex;
			continue;
		}
		return false;
	}

	while (pattern[patternIndex] === "*") patternIndex++;
	return patternIndex === pattern.length;
}

export function matchesAnyGlob(
	value: string,
	globs: string[] | undefined,
): boolean {
	const patterns = globs && globs.length > 0 ? globs : ["*"];
	return patterns.some((glob) => matchesGlob(value, glob));
}

export function adapterMatches(
	adapter: AdapterConfig,
	provider: string,
	model: string,
): boolean {
	if (adapter.enabled === false) return false;
	return (
		matchesGlob(provider, adapter.provider ?? "*") &&
		matchesAnyGlob(model, adapter.models)
	);
}

export function selectAdapter(
	config: QuotaStatusConfig,
	provider: string,
	model: string,
): AdapterConfig | undefined {
	return (config.adapters ?? []).find((adapter) =>
		adapterMatches(adapter, provider, model),
	);
}

export function modelKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

export function parseModelKey(key: string): ModelRef | undefined {
	const slash = key.indexOf("/");
	if (slash <= 0 || slash >= key.length - 1) return undefined;
	return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
}
