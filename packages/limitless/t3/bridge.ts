import { timingSafeEqual } from 'node:crypto'
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { type Backend, BridgeRequestError, forwardingHeaders, routeT3Request } from './requests'

export interface T3BridgeOptions {
	readonly backend: () => Promise<Backend>
	readonly password: string
	readonly hostname?: string
	readonly port?: number
}

function forwardingTarget(backend: Backend, incoming: URL, pathname = incoming.pathname): URL {
	const target = new URL(backend.url)
	// A normalized pathname can start with //; resolving it as a URL reference
	// would send the managed service's credentials to a caller-selected origin.
	target.pathname = pathname
	target.search = incoming.search
	target.hash = ''
	return target
}

export async function startT3Bridge(options: T3BridgeOptions) {
	const hostname = options.hostname ?? '127.0.0.1'
	if (!['127.0.0.1', '::1', 'localhost'].includes(hostname))
		throw new Error('The T3 bridge must listen on loopback')
	if (options.password.length === 0) throw new Error('T3 must supply a bridge password')
	const authorization = Buffer.from(
		`Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`,
	)
	const sockets = new Set<Socket>()
	const controllers = new Set<AbortController>()
	let closing: Promise<void> | undefined
	const authorized = (request: IncomingMessage) => {
		const value = Buffer.from(request.headers.authorization ?? '')
		return value.length === authorization.length && timingSafeEqual(value, authorization)
	}

	async function handle(incoming: IncomingMessage, outgoing: ServerResponse) {
		if (!authorized(incoming)) {
			outgoing.writeHead(401).end()
			return
		}
		if (closing) {
			outgoing.writeHead(503).end()
			return
		}
		const controller = new AbortController()
		controllers.add(controller)
		incoming.once('aborted', () => controller.abort())
		outgoing.once('close', () => {
			controller.abort()
			controllers.delete(controller)
		})
		try {
			const backend = await options.backend()
			const url = new URL(incoming.url ?? '/', 'http://bridge.invalid')
			const route = await routeT3Request(incoming, url, backend, controller.signal)
			if (controller.signal.aborted) return
			if (route.kind === 'reply') {
				outgoing.writeHead(route.reply.status, route.reply.headers).end(route.reply.body)
				return
			}
			const headers = forwardingHeaders(incoming.headers, backend)
			if (route.body) {
				delete headers['transfer-encoding']
				headers['content-length'] = String(route.body.length)
			}
			const request = backend.url.protocol === 'https:' ? httpsRequest : httpRequest
			const forwarded = request(
				forwardingTarget(backend, url, route.pathname),
				{
					method: incoming.method,
					headers,
					signal: controller.signal,
				},
				(response) => {
					const status = response.statusCode ?? 502
					outgoing.writeHead(status, response.headers)
					response.pipe(outgoing)
					response.on('error', () => outgoing.destroy())
				},
			)
			forwarded.on('error', () => {
				if (controller.signal.aborted || outgoing.destroyed) return
				if (outgoing.headersSent) outgoing.destroy()
				else outgoing.writeHead(502).end('OpenCode service request failed')
			})
			if (route.body) forwarded.end(route.body)
			else incoming.pipe(forwarded)
		} catch (error) {
			if (controller.signal.aborted || outgoing.destroyed) return
			if (outgoing.headersSent) {
				outgoing.destroy()
				return
			}
			const status = error instanceof BridgeRequestError ? error.status : 502
			outgoing
				.writeHead(status, { 'content-type': 'text/plain' })
				.end(
					error instanceof BridgeRequestError
						? error.message
						: 'Limitless T3 integration failed; check that the managed service and plugin are available',
				)
		}
	}

	const server = createServer((request, response) => {
		void handle(request, response)
	})
	server.on('connection', (socket) => {
		sockets.add(socket)
		socket.once('close', () => sockets.delete(socket))
	})
	server.on('upgrade', (incoming, downstream, head) => {
		if (!authorized(incoming) || closing) {
			downstream.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
			return
		}
		void options.backend().then(
			(backend) => {
				if (downstream.destroyed) return
				const url = new URL(incoming.url ?? '/', 'http://bridge.invalid')
				const request = backend.url.protocol === 'https:' ? httpsRequest : httpRequest
				const forwarded = request(forwardingTarget(backend, url), {
					method: 'GET',
					headers: forwardingHeaders(incoming.headers, backend),
				})
				forwarded.on('upgrade', (response, upstream, upstreamHead) => {
					const lines = [
						`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`,
					]
					for (let index = 0; index < response.rawHeaders.length; index += 2)
						lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
					downstream.write(`${lines.join('\r\n')}\r\n\r\n`)
					if (upstreamHead.length) downstream.write(upstreamHead)
					if (head.length) upstream.write(head)
					upstream.pipe(downstream)
					downstream.pipe(upstream)
					upstream.on('error', () => downstream.destroy())
					downstream.on('error', () => upstream.destroy())
					upstream.on('close', () => downstream.destroy())
					downstream.on('close', () => upstream.destroy())
				})
				forwarded.on('response', (response) => {
					downstream.end(
						`HTTP/1.1 ${response.statusCode} Upgrade rejected\r\nConnection: close\r\n\r\n`,
					)
					response.resume()
				})
				forwarded.on('error', () => downstream.destroy())
				downstream.on('close', () => forwarded.destroy())
				forwarded.end()
			},
			() => downstream.destroy(),
		)
	})

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(options.port ?? 0, hostname, resolve)
	})
	const address = server.address()
	if (address === null || typeof address === 'string')
		throw new Error('T3 bridge did not bind a TCP port')
	const url = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`

	return {
		url,
		close: () => {
			if (closing) return closing
			closing = (async () => {
				for (const controller of controllers) controller.abort()
				await new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()))
					for (const socket of sockets) socket.destroy()
				})
			})()
			return closing
		},
	}
}
