// Execute selected actual legacy TS without loading its database or credentials.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = process.argv[2];
const source = fs.readFileSync(path.join(root, 'lib/appSync.ts'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'lib/appSyncSchema.ts'), 'utf8');
const select = (text, pattern) => {
  const line = text.split('\n').find(value => pattern.test(value));
  if (!line) throw new Error('Legacy contract function changed');
  return line;
};
const selected = [
  select(schema, /^export const APP_SYNC_DOMAINS=/).replace('export ', ''),
  select(source, /^const namespaces=/),
  select(source, /^function canonical\(/),
  select(source, /^export const appSyncDiscovery=/).replace('export ', ''),
].join('\n');
const context = vm.createContext({});
vm.runInContext(ts.transpileModule(selected, { compilerOptions: {target: ts.ScriptTarget.ES2022} }).outputText, context);
const vectors = [null, true, 0, 9007199254740991, 'a"b', {b: 2, a: [null, true]}, {changes: [{key:'["notes","US.A"]', revision:0, value:'备注'}], namespace:'watch', requestId:'00000000-0000-4000-8000-000000000001'}];
context.inputs = vectors;
const result = vm.runInContext('({discovery: appSyncDiscovery(), canonical: inputs.map(canonical)})', context);
process.stdout.write(JSON.stringify(result));
