import { Schema } from 'effect'

export function portableSchema<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
	// Keep validation in its owning runtime rather than passing Effect ASTs across runtime copies.
	const validation = Schema.toStandardSchemaV1(schema)['~standard']
	const jsonSchema = Schema.toStandardJSONSchemaV1(schema)['~standard'].jsonSchema
	return { '~standard': { ...validation, jsonSchema } }
}
