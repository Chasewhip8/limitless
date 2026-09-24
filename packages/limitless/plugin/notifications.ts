import type { Attention, Data, Toast } from '@opencode/plugin/tui/context'

type Session = NonNullable<ReturnType<Data['session']['get']>>
type Message = ReturnType<Data['session']['message']['list']>[number]

export interface NotificationContext {
	readonly attention: Attention
	readonly ui: { readonly toast: Toast }
	readonly data: {
		readonly on: Data['on']
		readonly session: {
			get(sessionID: string): Pick<Session, 'title' | 'parentID'> | undefined
			readonly sync: Data['session']['sync']
			readonly status: Data['session']['status']
			readonly message: Pick<Data['session']['message'], 'list' | 'sync'>
			readonly pending: {
				list(sessionID: string): readonly unknown[]
				readonly sync: Data['session']['pending']['sync']
			}
		}
	}
}

function hasFinalResponse(messages: readonly Message[], eventID: string): boolean {
	// Match the projected execution boundary, so an old answer cannot qualify a later empty run.
	const terminal = messages.at(-1)
	if (
		terminal?.type !== 'idle' ||
		terminal.outcome !== 'succeeded' ||
		terminal.id !== eventID.replace(/^evt_/, 'msg_')
	) {
		return false
	}

	for (let index = messages.length - 2; index >= 0; index--) {
		const message = messages[index]
		if (
			!message ||
			message.type === 'idle' ||
			message.type === 'user' ||
			message.type === 'synthetic'
		) {
			return false
		}
		if (message.type === 'compaction' && message.status !== 'completed') return false
		if (message.type === 'assistant') {
			return (
				message.time.completed !== undefined &&
				message.error === undefined &&
				message.finish === 'stop' &&
				message.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
			)
		}
	}
	return false
}

export function registerNotifications(context: NotificationContext): () => void {
	const terminalSessions = new Set<string>()
	const lastSoundedCompletion = new Map<string, string>()
	const forms = new Set<string>()
	const permissions = new Set<string>()
	let disposed = false

	function reportError(error: unknown) {
		console.error('[limitless] Notification failed', error)
	}

	function notify(
		sessionID: string,
		message: string,
		sound: 'question' | 'permission' | false,
		title?: string,
	) {
		const session = context.data.session.get(sessionID)
		const notification = session?.parentID === undefined
		if (!notification && !sound) return
		const resolvedTitle = title ?? session?.title
		return context.attention
			.notify({
				...(resolvedTitle === undefined ? {} : { title: resolvedTitle }),
				message,
				notification: notification ? { when: 'blurred' } : false,
				sound: sound ? { name: sound, when: 'always' } : false,
			})
			.catch(reportError)
	}

	async function soundForCompletion(sessionID: string, eventID: string) {
		const sessions = context.data.session
		if (sessions.get(sessionID)?.parentID !== undefined) return
		await Promise.all([
			sessions.get(sessionID) ? undefined : sessions.sync(sessionID),
			sessions.message.sync(sessionID),
			sessions.pending.sync(sessionID),
		])
		if (disposed || lastSoundedCompletion.get(sessionID) === eventID) return
		const session = sessions.get(sessionID)
		if (!session || session.parentID !== undefined || sessions.status(sessionID) !== 'idle') return
		if (sessions.pending.list(sessionID).length > 0) return
		if (!hasFinalResponse(sessions.message.list(sessionID), eventID)) return
		lastSoundedCompletion.set(sessionID, eventID)
		await context.attention.notify({
			...(session.title === undefined ? {} : { title: session.title }),
			message: 'Session done',
			notification: false,
			sound: { name: 'done', when: 'always' },
		})
	}

	const cleanup = [
		context.data.on('form.created', (event) => {
			const form = event.data.form
			if (forms.has(form.id)) return
			forms.add(form.id)
			return notify(form.sessionID, 'Input needs response', 'question', form.title)
		}),
		context.data.on('form.replied', (event) => forms.delete(event.data.id)),
		context.data.on('form.cancelled', (event) => forms.delete(event.data.id)),
		context.data.on('permission.asked', (event) => {
			if (permissions.has(event.data.id)) return
			permissions.add(event.data.id)
			return notify(event.data.sessionID, 'Permission needs input', 'permission')
		}),
		context.data.on('permission.replied', (event) => permissions.delete(event.data.requestID)),
		context.data.on('session.execution.started', (event) =>
			terminalSessions.delete(event.data.sessionID),
		),
		context.data.on('session.execution.succeeded', (event) => {
			const sessionID = event.data.sessionID
			const notification = terminalSessions.has(sessionID)
				? undefined
				: notify(sessionID, 'Session done', false)
			terminalSessions.add(sessionID)
			return Promise.all([notification, soundForCompletion(sessionID, event.id)]).catch(reportError)
		}),
		context.data.on('session.execution.interrupted', (event) => {
			if (terminalSessions.has(event.data.sessionID)) return
			terminalSessions.add(event.data.sessionID)
			return notify(event.data.sessionID, 'Session done', false)
		}),
		context.data.on('session.execution.failed', (event) => {
			const sessionID = event.data.sessionID
			if (terminalSessions.has(sessionID)) return
			terminalSessions.add(sessionID)
			context.ui.toast.show({
				sessionID,
				title: 'Session failed',
				message: event.data.error.message,
				variant: 'error',
			})
			return notify(sessionID, event.data.error.message, false)
		}),
	]

	return () => {
		if (disposed) return
		disposed = true
		for (const dispose of cleanup.reverse()) dispose()
	}
}
