import {spawnSync} from 'node:child_process';
const files = ['platform-gateway','platform-navigation','system-refresh','workspace-motion','popover-interactions','records-refresh','auth-client','cash-balance-client','feed-agent-client','feed-agent-playback','feed-client','feed-style','futu-connection-client','liquid-glass','quote-pool-client','simple-ledger-security','site-palettes','stock-chart-controls','workspace-background'];
for (const name of files) {
 console.log('\nTEST '+name);
 const result=spawnSync(process.execPath,['tests/'+name+'.cjs'],{stdio:'inherit'});
 if(result.status!==0)process.exit(result.status??1);
}
