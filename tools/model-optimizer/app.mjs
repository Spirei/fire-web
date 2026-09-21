import { execFileSync } from 'node:child_process';
import { exportModel } from './export.mjs';
const args = process.argv.slice(2);
function dialog(script, values = []) {
  return execFileSync('/usr/bin/osascript', ['-e', script, ...values], { encoding: 'utf8' }).trim();
}
try {
  let inputs, output;
  if (args.includes('--gui')) {
    if (process.platform !== 'darwin') throw new Error('文件选择窗口仅支持 macOS；其他系统使用 --input 文件 --output 目录');
    inputs = dialog(`set selectedFiles to choose file with prompt "选择原始 GLB 模型（可多选）" with multiple selections allowed
set resultPaths to ""
repeat with selectedFile in selectedFiles
set resultPaths to resultPaths & POSIX path of selectedFile & linefeed
end repeat
return resultPaths`).split('\n').filter(Boolean);
    output = dialog('return POSIX path of (choose folder with prompt "选择导出目录，原文件不会被修改")');
  } else {
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw new Error('用法：node app.mjs --input 模型.glb --output 导出目录');
    inputs = [args[1]]; output = args[3];
  }
  let failed = 0;
  for (const [index, input] of inputs.entries()) {
    console.log(`\n[${index + 1}/${inputs.length}] ${input}`);
    try {
      const result = await exportModel(input, output);
      console.log(`完成：${result}`);
    } catch (error) { failed++; console.error(`失败：${error.message}`); }
  }
  if (args.includes('--gui')) {
    execFileSync('/usr/bin/open', [output]);
    dialog('on run argv\ndisplay dialog (item 1 of argv) buttons {"好"} default button "好" with title "Fire 模型工具"\nend run', [`完成 ${inputs.length - failed} 个，失败 ${failed} 个。\n导出文件夹内有上传说明；网站不再执行转码。`]);
  }
  if (failed) process.exitCode = 1;
} catch (error) {
  if (String(error.stderr ?? error.message).includes('(-128)')) console.log('已取消。');
  else { console.error(error.message); process.exitCode = 1; }
}
