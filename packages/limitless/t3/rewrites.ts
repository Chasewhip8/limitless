import { Effect } from 'effect'
import type { HttpServerRequest } from 'effect/http'
import { type Backend, BridgeError } from '../bridge/backend'
import {
	decodePathSegment,
	forwardWith,
	readControlBody,
	routeBuildSelection,
} from '../bridge/requests'
import { T3_CONTEXT } from './instructions'
import { canonicalT3Namespace } from './permissions'

const mcpServerPath = /^(\/api\/experimental\/mcp\/)(t3-code-[^/]+)(.*)$/
const t3InstructionsPath =
	/^\/api\/(?:experimental\/)?session\/[^/]+\/instructions\/entries\/t3-code$/
const t3Namespace = /^t3-code-[A-Za-z0-9_-]{1,56}$/

export const routeT3Request = Effect.fn('T3.routeRequest')(function* (
	request: HttpServerRequest.HttpServerRequest,
	pathname: string,
	backend: Backend,
) {
	const mcpServer = mcpServerPath.exec(pathname)
	if (mcpServer !== null) {
		const [, prefix = '', encodedName = '', suffix = ''] = mcpServer
		const name = yield* decodePathSegment(encodedName)
		if (!t3Namespace.test(name))
			return yield* new BridgeError({ status: 400, message: 'Invalid T3 MCP namespace' })
		return forwardWith({ pathname: `${prefix}${canonicalT3Namespace(name)}${suffix}` })
	}

	if (request.method === 'PUT' && t3InstructionsPath.test(pathname)) {
		const body = yield* readControlBody(request, 'T3')
		if (!Object.hasOwn(body, 'value'))
			return yield* new BridgeError({
				status: 400,
				message: 'T3 instruction entry is missing its value',
			})
		return forwardWith({ body: { ...body, value: T3_CONTEXT } })
	}

	const selection = yield* routeBuildSelection(request, pathname, backend, 'T3')
	if (selection !== undefined) return selection

	return forwardWith()
})
