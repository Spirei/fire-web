import { exportModel } from './export.mjs';
import { startServer } from './server.mjs';
const args = process.argv.slice(2);
try {
  if (!args.length) {
    const instance = await startServer();
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (stopping) return; stopping = true;
      void instance.close().then(() => process.exit(0));
    });
  }
  else {
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw new Error('用法：npm start，或 node app.mjs --input 模型.glb --output 导出目录');
    console.log(`完成：${await exportModel(args[1], args[3])}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
