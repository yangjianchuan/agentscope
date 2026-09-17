import type { ChatModelConfig, ModelCard } from '@/api';

interface ParameterProperty {
	type?: string;
	enum?: unknown[];
	anyOf?: ParameterProperty[];
}

interface ParameterSchema {
	properties?: Record<string, ParameterProperty>;
}

function enumValues(property: ParameterProperty | undefined): unknown[] {
	if (!property) return [];
	if (property.enum) return property.enum;
	for (const variant of property.anyOf ?? []) {
		if (variant.type !== 'null' && variant.enum) return variant.enum;
	}
	return [];
}

/** Defaults applied when a chat model configuration is first created. */
export function defaultChatModelParameters(modelCard: ModelCard): Record<string, unknown> {
	const schema = modelCard.parameter_schema as ParameterSchema;
	const properties = schema.properties ?? {};
	const defaults: Record<string, unknown> = {};

	const hiddenThinkingParameter =
		modelCard.parameters_overrides.thinking_enable?.hidden === true;
	if (properties.thinking_enable || hiddenThinkingParameter) {
		defaults.thinking_enable = true;
	}

	if (enumValues(properties.reasoning_effort).includes('high')) {
		defaults.reasoning_effort = 'high';
	}

	return defaults;
}

/** Add current defaults without replacing parameters the user already set. */
export function withDefaultChatModelParameters(
	config: ChatModelConfig,
	modelCard: ModelCard | null | undefined,
): ChatModelConfig {
	if (!modelCard) return config;

	const defaults = defaultChatModelParameters(modelCard);
	const missingDefaults = Object.entries(defaults).filter(
		([key]) => !Object.prototype.hasOwnProperty.call(config.parameters, key),
	);
	if (missingDefaults.length === 0) return config;

	return {
		...config,
		parameters: {
			...Object.fromEntries(missingDefaults),
			...config.parameters,
		},
	};
}
