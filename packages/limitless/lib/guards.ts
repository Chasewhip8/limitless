export function objectProperty(value: unknown, key: PropertyKey): unknown {
	if (typeof value !== 'object' || value === null) return undefined
	return Reflect.get(value, key)
}

export function describeUnknown(value: unknown): string {
	if (value instanceof Error) return value.message
	if (typeof value === 'object' && value !== null) {
		try {
			return JSON.stringify(value)
		} catch (error) {
			const fallback = Object.prototype.toString.call(value)
			return error instanceof Error ? `${fallback}: ${error.message}` : fallback
		}
	}
	return String(value)
}

export function schemaErrorMessage(error: { readonly message: string }): string {
	return error.message.slice(0, 2_000)
}
