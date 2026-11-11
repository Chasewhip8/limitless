// Keep executable source literal: bundlers rewrite require/import references inside serialized functions.
export const workspaceSupervisorSource = `
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const lock = 3;

let state = { _tag: 'Idle' };
const closeInput = () => {
 switch (state._tag) {
  case 'Idle': process.exit(0); break;
  case 'Running':
   state = { _tag: 'Draining', child: state.child };
   state.child.stdout?.resume();
   break;
  case 'Draining': break;
 }
};
const send = event => {
 if (state._tag === 'Draining') return true;
 return process.stdout.write(JSON.stringify(event) + String.fromCharCode(10));
};
process.stdout.on('error', closeInput);
process.stdin.on('error', closeInput);
const input = createInterface({ input: process.stdin });
input.on('close', closeInput);
input.on('line', line => {
 if (state._tag !== 'Idle') { closeInput(); return; }
 try {
  const request = JSON.parse(line);
  const env = { ...process.env };
  for (const [key, value] of Object.entries(request.env)) {
   if (value === null) delete env[key];
   else env[key] = value;
  }
  // Numeric stdio duplicates the locked description as fd 3 without FD_CLOEXEC.
  // The supervisor drains/reaps synchronous Git/tar children before exiting on helper EOF.
  // Inherited fd 3 protects surviving writers, but not arbitrary detached, fd-closing programs.
  const child = spawn(request.executable, request.args, {
   cwd: request.cwd, env, detached: false,
   stdio: ['ignore', 'pipe', 'ignore', lock]
  });
  state = { _tag: 'Running', child };
  // Node emits close after spawn errors; only close completes and reaps the request.
  child.on('error', () => {});
  child.on('close', code => {
   if (state._tag === 'Draining') process.exit(0);
   state = { _tag: 'Idle' };
   send({ _tag: 'Exited', code: code ?? 1 });
  });
  const output = child.stdout;
  if (output === null) { closeInput(); child.kill('SIGTERM'); return; }
  output.on('data', bytes => {
   if (!send({ _tag: 'Output', bytes: bytes.toString('base64') })) {
    output.pause();
    process.stdout.once('drain', () => output.resume());
   }
  });
 } catch { send({ _tag: 'Exited', code: 1 }); }
});
send({ _tag: 'Locked' });
`
