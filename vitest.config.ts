import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: false,
		include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
		passWithNoTests: true,
		pool: 'forks',
		poolOptions: {
			forks: {
				singleFork: true,
			},
		},
	},
})
