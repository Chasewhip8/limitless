import {
	Model,
	type ProviderPackageDefinition,
	type ProviderPackageSettings,
} from '@opencode-ai/ai'
import { AnthropicMessages } from '@opencode-ai/ai/protocols/anthropic-messages'
import { Anthropic } from '@opencode-ai/ai/providers'
import { Auth, Endpoint, Framing, Route } from '@opencode-ai/ai/route'
import { Effect } from 'effect'
import { Headers } from 'effect/unstable/http'
import { MAX_METADATA_KEY, REQUIRED_BETAS, USER_AGENT } from './constants'
import { isMarkedMaxSettings } from './oauth'
import { maxOAuthProtocol } from './protocol'
import { mergeBetaHeader } from './transform'

type Thinking =
	| { readonly type: 'adaptive'; readonly display?: 'summarized' | 'omitted' }
	| { readonly type: 'disabled' }
	| {
			readonly type: 'enabled'
			readonly budgetTokens?: number
			readonly budget_tokens?: number
	  }

type AuthSettings =
	| { readonly apiKey?: string; readonly authToken?: never }
	| { readonly apiKey?: never; readonly authToken?: string }

type ProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>

export type Settings = ProviderPackageSettings &
	AuthSettings & {
		readonly baseURL?: string
		readonly thinking?: Thinking
		readonly effort?: string
		readonly providerOptions?: ProviderOptions
		readonly [MAX_METADATA_KEY]?: unknown
	}

const oauthHeaders = (accessToken: string) =>
	Auth.bearer(accessToken)
		.andThen(Auth.remove('x-api-key'))
		.andThen(
			Auth.custom((input) =>
				Effect.succeed(
					Headers.setAll(input.headers, {
						'anthropic-beta': mergeBetaHeader(input.headers['anthropic-beta']),
						'user-agent': USER_AGENT,
					}),
				),
			),
		)

export const model: ProviderPackageDefinition<Settings>['model'] = (modelID, settings) => {
	const {
		[MAX_METADATA_KEY]: _metadata,
		apiKey,
		authToken,
		baseURL,
		headers,
		body,
		limits,
		providerOptions: configuredProviderOptions,
		...anthropicSettings
	} = settings
	const providerOptions = mergeProviderOptions(configuredProviderOptions, anthropicSettings)

	if (isMarkedMaxSettings(settings)) {
		if (!apiKey || authToken !== undefined) {
			throw new Error(
				'Claude Max OAuth metadata was present without an access token; reconnect Anthropic.',
			)
		}

		return Route.make({
			id: 'limitless-anthropic-max-messages',
			provider: 'anthropic',
			providerMetadataKey: 'anthropic',
			protocol: maxOAuthProtocol,
			endpoint: Endpoint.path(AnthropicMessages.PATH, {
				baseURL: baseURL ?? AnthropicMessages.DEFAULT_BASE_URL,
				query: { beta: 'true' },
			}),
			auth: oauthHeaders(apiKey),
			framing: Framing.sse,
			headers: () => ({ 'anthropic-version': '2023-06-01' }),
			defaults: {
				...(headers === undefined ? {} : { headers: { ...headers } }),
				...(body === undefined ? {} : { http: { body: { ...body } } }),
				...(limits === undefined ? {} : { limits }),
				...(providerOptions === undefined ? {} : { providerOptions }),
			},
		}).model({ id: modelID })
	}

	if (apiKey !== undefined && authToken !== undefined) {
		throw new Error('Anthropic apiKey cannot be combined with authToken')
	}
	const selected = Anthropic.model(modelID, {
		...(authToken === undefined ? (apiKey === undefined ? {} : { apiKey }) : { authToken }),
		...(baseURL === undefined ? {} : { baseURL }),
		...(headers === undefined ? {} : { headers }),
		...(body === undefined ? {} : { body }),
		...(limits === undefined ? {} : { limits }),
		...(providerOptions === undefined ? {} : { providerOptions }),
	})
	return providerOptions === undefined
		? selected
		: Model.update(selected, { route: selected.route.with({ providerOptions }) })
}

export const requiredOAuthBetas: ReadonlyArray<string> = REQUIRED_BETAS

function mergeProviderOptions(
	configured: ProviderOptions | undefined,
	anthropic: Readonly<Record<string, unknown>>,
): ProviderOptions | undefined {
	if (Object.keys(anthropic).length === 0) return configured
	return {
		...configured,
		anthropic: {
			...configured?.anthropic,
			...anthropic,
		},
	}
}
