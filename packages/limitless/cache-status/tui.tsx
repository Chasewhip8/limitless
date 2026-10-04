import { Plugin } from '@opencode/plugin/tui'
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import { cacheStatus } from './status'

export default Plugin.define({
	id: 'limitless.cache-status',
	setup(context) {
		return context.ui.slot({
			append: 'prompt.footer',
			render: (input) => (
				<Show when={input.mode === 'normal' && input.sessionID}>
					{(sessionID) => <CacheDot context={context} sessionID={sessionID()} />}
				</Show>
			),
		})
	},
})

function CacheDot(props: { readonly context: Plugin.Context; readonly sessionID: string }) {
	// Date.now() is not reactive; bumping this re-evaluates the status when the cache expires.
	const [expiry, setExpiry] = createSignal(0)
	const status = createMemo(() => {
		expiry()
		return cacheStatus({
			messages: props.context.data.session.message.list(props.sessionID),
			running: props.context.data.session.status(props.sessionID) === 'running',
			now: Date.now(),
		})
	})

	createEffect(() => {
		const current = status()
		if (current?.state !== 'warm' || current.expiresAt === undefined) return
		const timer = setTimeout(() => setExpiry((count) => count + 1), current.expiresAt - Date.now())
		onCleanup(() => clearTimeout(timer))
	})

	const color = () => {
		const theme = props.context.theme
		switch (status()?.state) {
			case 'warm':
				return theme.text.feedback.success.base
			case 'cold':
				return theme.text.feedback.error.base
			default:
				return theme.text.muted
		}
	}

	return (
		<Show when={status()}>
			<text fg={color()} flexShrink={0}>
				⊙
			</text>
		</Show>
	)
}
