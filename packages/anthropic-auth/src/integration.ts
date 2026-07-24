import type { IntegrationDraft } from '@opencode-ai/plugin/v2/effect/integration'
import { Effect } from 'effect'
import { MAX_METHOD_ID } from './constants'
import { authorize, exchange, maxCredential, refreshCredential } from './oauth'

export function applyAnthropicIntegration(integrations: IntegrationDraft): void {
	integrations.method.update({
		integrationID: 'anthropic',
		method: {
			id: MAX_METHOD_ID,
			type: 'oauth',
			label: 'Claude Pro/Max',
		},
		authorize: () =>
			authorize().pipe(
				Effect.map((authorization) => ({
					url: authorization.url,
					instructions: 'Paste the authorization code here:',
					mode: 'code' as const,
					callback: (code: string) =>
						exchange(
							code,
							authorization.verifier,
							authorization.redirectUri,
							authorization.state,
						).pipe(Effect.map(maxCredential)),
				})),
			),
		refresh: (credential) => refreshCredential(credential),
	})
}
