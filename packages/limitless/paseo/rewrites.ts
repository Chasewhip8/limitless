import { Effect, Schema } from 'effect'
import type { HttpServerRequest } from 'effect/http'
import { type Backend, BridgeError } from '../bridge/backend'
import {
	defaultAgentFor,
	forwardWith,
	readControlBody,
	relayRejection,
	routeBuildSelection,
} from '../bridge/requests'

const sessionCreatePath = /^\/api\/session\/?$/
const mcpRegistrationPath = /^\/api\/experimental\/mcp\/[^/]+$/

const CreateLocation = Schema.Struct({ directory: Schema.String })

/**
 * Decides how a Paseo request reaches the managed service:
 *
 * - Session creation drops Paseo's session permission rules. They come from
 *   Paseo provider options and would be evaluated after, and so override, the
 *   native agent rules that scope each role; native children inherit them.
 * - Paseo creates sessions with OpenCode's built-in `build` agent when no mode
 *   is chosen. Limitless disables it, so the Location's configured default
 *   agent is selected instead, at creation and on later switches.
 * - Paseo registers an agent's custom MCP servers per Location and isolates
 *   them by giving that agent its own OpenCode server. In the shared service
 *   they would reach every session in the Location, so they are refused.
 */
export const routePaseoRequest = Effect.fn('Paseo.routeRequest')(function* (
	request: HttpServerRequest.HttpServerRequest,
	pathname: string,
	backend: Backend,
) {
	if (request.method === 'PUT' && mcpRegistrationPath.test(pathname))
		return yield* new BridgeError({
			status: 501,
			message:
				'opencode-paseo does not support per-agent MCP servers; configure MCP servers in OpenCode instead',
		})

	if (request.method === 'POST' && sessionCreatePath.test(pathname)) {
		const { permissions: _paseoRules, ...body } = yield* readControlBody(request, 'Paseo')
		if (body.agent !== 'build') return forwardWith({ body })
		const location = Schema.decodeUnknownOption(CreateLocation)(body.location)
		if (location._tag === 'None')
			return yield* new BridgeError({
				status: 400,
				message: 'Paseo session creation must name a location directory',
			})
		return yield* relayRejection(
			defaultAgentFor(backend, location.value.directory).pipe(
				Effect.map((agent) => forwardWith({ body: { ...body, agent } })),
			),
		)
	}

	const selection = yield* routeBuildSelection(request, pathname, backend, 'Paseo')
	if (selection !== undefined) return selection

	return forwardWith()
})
