import { Effect } from 'effect'
import { OAuthError } from './oauth-error'

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function generatePKCE() {
	return Effect.tryPromise({
		try: async () => {
			const bytes = new Uint8Array(64)
			crypto.getRandomValues(bytes)
			const verifier = base64UrlEncode(bytes)
			const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
			return {
				verifier,
				challenge: base64UrlEncode(new Uint8Array(digest)),
				method: 'S256' as const,
			}
		},
		catch: () =>
			new OAuthError({
				operation: 'authorize',
				message: 'Unable to create the OAuth PKCE challenge.',
				transient: false,
			}),
	})
}
