'use strict';
require('esbuild').buildSync({
  entryPoints: [require('node:path').join(__dirname, 'worker.ts')],
  outfile: require('node:path').join(__dirname, '../server-tools/worker.cjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', packages: 'external',
  logLevel: 'warning'
});
