const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')

// Some Sentry commands launch user-controlled processes, which must not inherit
// the wrapper-injected API credential needed by the CLI itself.
const tokenKeys = ['SENTRY_AUTH_TOKEN', 'SENTRY_TOKEN']

const scrubEnvironment = (environment = process.env) => {
	const scrubbed = { ...environment }
	for (const key of tokenKeys) delete scrubbed[key]
	return scrubbed
}

const withScrubbedEnvironment = (options) => ({
	...(options ?? {}),
	env: scrubEnvironment(options?.env),
})

const originalSpawn = childProcess.spawn
childProcess.spawn = function spawn(command, args, options) {
	if (Array.isArray(args)) {
		return originalSpawn.call(this, command, args, withScrubbedEnvironment(options))
	}
	return originalSpawn.call(this, command, withScrubbedEnvironment(args))
}

const originalSpawnSync = childProcess.spawnSync
childProcess.spawnSync = function spawnSync(command, args, options) {
	if (Array.isArray(args)) {
		return originalSpawnSync.call(this, command, args, withScrubbedEnvironment(options))
	}
	return originalSpawnSync.call(this, command, withScrubbedEnvironment(args))
}

const originalExec = childProcess.exec
childProcess.exec = function exec(command, options, callback) {
	if (typeof options === 'function' || options === undefined) {
		return originalExec.call(this, command, withScrubbedEnvironment(), options)
	}
	return originalExec.call(this, command, withScrubbedEnvironment(options), callback)
}

const originalExecSync = childProcess.execSync
childProcess.execSync = function execSync(command, options) {
	return originalExecSync.call(this, command, withScrubbedEnvironment(options))
}

const originalExecFile = childProcess.execFile
childProcess.execFile = function execFile(file, args, options, callback) {
	if (Array.isArray(args)) {
		if (typeof options === 'function' || options === undefined) {
			return originalExecFile.call(this, file, args, withScrubbedEnvironment(), options)
		}
		return originalExecFile.call(this, file, args, withScrubbedEnvironment(options), callback)
	}

	if (typeof args === 'function' || args === undefined) {
		return originalExecFile.call(this, file, [], withScrubbedEnvironment(), args)
	}

	return originalExecFile.call(this, file, [], withScrubbedEnvironment(args), options)
}

const originalExecFileSync = childProcess.execFileSync
childProcess.execFileSync = function execFileSync(file, args, options) {
	if (Array.isArray(args)) {
		return originalExecFileSync.call(this, file, args, withScrubbedEnvironment(options))
	}
	return originalExecFileSync.call(this, file, [], withScrubbedEnvironment(args))
}

const originalFork = childProcess.fork
childProcess.fork = function fork(modulePath, args, options) {
	if (Array.isArray(args)) {
		return originalFork.call(this, modulePath, args, withScrubbedEnvironment(options))
	}
	return originalFork.call(this, modulePath, [], withScrubbedEnvironment(args))
}

if (typeof process.execve === 'function') {
	const originalExecve = process.execve
	process.execve = (file, args, environment) =>
		originalExecve(file, args, scrubEnvironment(environment))
}

syncBuiltinESMExports()
