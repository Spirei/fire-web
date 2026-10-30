'use strict';
// This connection is never pooled across transactions. No automatic retry after an unknown write.
const { workerData } = require('node:worker_threads');
const { Client, types } = require('pg');
// Calendar dates and unzoned timestamps must not acquire a fabricated timezone or clock time.
for (const oid of [1082,1114]) types.setTypeParser(oid, value => value);
for (const oid of [20, 1700]) types.setTypeParser(oid, value => {
  const number = Number(value);
  if (!Number.isFinite(number) || oid === 20 && !Number.isSafeInteger(number)) throw Error('Database number exceeds the application contract');
  return number;
});
const port = workerData.port, client = new Client(workerData.connection);
const ready = client.connect();
let fatal = null, guards = '';
client.on('error', error => { fatal = error; });
function buffers(value) {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(buffers);
  return value;
}
port.on('message', async message => {
  const signal = new Int32Array(message.signal);
  try {
    await ready;
    if (fatal) throw fatal;
    if (message.op === 'close') { await client.end(); port.postMessage({ id: message.id, value: null }); }
    else {
      const context = JSON.stringify(message.guards ?? {});
      const control = /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(message.sql.trim());
      if (!control && context !== guards) {
        await client.query("SELECT set_config('alcor.trade_correction_ids',$1,false),set_config('alcor.fee_correction_ids',$2,false)", [JSON.stringify(message.guards?.tradeCorrection ?? []), JSON.stringify(message.guards?.feeCorrection ?? [])]);
        guards = context;
      }
      const result = await client.query(message.sql, (message.values ?? []).map(buffers));
      if (control) guards = '';
      const results = Array.isArray(result) ? result : [result];
      port.postMessage({ id: message.id, value: results.map(r => ({ rows: r.rows, rowCount: r.rowCount, fields: r.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })) })) });
    }
  } catch (error) {
    port.postMessage({ id: message.id, error: { message: error.message, code: error.code, constraint: error.constraint } });
  } finally { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); }
});
ready.catch(() => {});
