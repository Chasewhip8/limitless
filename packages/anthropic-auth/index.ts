import { defineAnthropicAuthPlugin } from './src/plugin'

export default defineAnthropicAuthPlugin(import.meta.url)
export { model } from './src/provider'
