import type { Plugin } from '@opencode/plugin/tui'
import { registerNotifications } from './plugin/notifications'

export default {
	// The pinned TUI replaces built-ins by ID, preserving the user's plugin directives.
	id: 'opencode.notifications',
	setup: registerNotifications,
} satisfies Plugin.Definition
