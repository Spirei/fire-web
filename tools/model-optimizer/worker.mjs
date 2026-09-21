import { exportModel } from './export.mjs';
const send = event => process.stdout.write(`FIRE_EVENT ${JSON.stringify(event)}\n`);
try {
  const output = await exportModel(process.argv[2], process.argv[3], { progress: message => send({ message }) });
  send({ output });
} catch (error) { send({ error: error.message }); process.exitCode = 1; }
