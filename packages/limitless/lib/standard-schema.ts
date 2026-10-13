import { Schema } from 'effect'

export function portableSchema<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
	// A bundled plugin and OpenCode have separate Effect runtimes. Keep validation
	// in the schema's owning runtime instead of passing its AST across that boundary.
	const validation = Schema.toStandardSchemaV1(schema)['~standard']
	const jsonSchema = Schema.toStandardJSONSchemaV1(schema)['~standard'].jsonSchema
	return { '~standard': { ...validation, jsonSchema } }
}
