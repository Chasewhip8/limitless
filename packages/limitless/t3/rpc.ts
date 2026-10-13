import { Rpc } from '@opencode/plugin/rpc'
import { Permission } from '@opencode/schema/permission'
import { Session } from '@opencode/schema/session'
import { Schema } from 'effect'
import { portableSchema } from '../lib/standard-schema'

const failure = portableSchema(Schema.Struct({ sessionID: Session.ID }))
const errors = {
	session_not_found: failure,
	wrong_location: failure,
	invalid_policy: failure,
}

export const T3PolicyRpc = Rpc.define({
	id: 'limitless.t3',
	events: {},
	methods: {
		updatePermissions: {
			input: portableSchema(
				Schema.Struct({ sessionID: Session.ID, permissions: Permission.Ruleset }),
			),
			output: portableSchema(Schema.Null),
			errors,
		},
		prepareSession: {
			input: portableSchema(Schema.Struct({ sessionID: Session.ID })),
			output: portableSchema(Schema.Null),
			errors,
		},
	},
})
