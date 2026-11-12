import {spawnSync} from 'node:child_process';
const files = ['source-settings-patch','market-history-ready','private-read-polish','migration-read-regressions','fx-first-frame','celeb-directory','api-catalogue','workspace-bootstrap','deployment-command','image-crop','first-run-setup','platform-startup','deploy-run-title','deploy-progress','shared-controls','search-history','platform-gateway','platform-navigation','system-refresh','platform-request','system-actions','workspace-motion','popover-interactions','records-refresh','auth-client','cash-balance-client','feed-agent-client','feed-agent-playback','feed-client','feed-style','futu-connection-client','liquid-glass','quote-pool-client','simple-ledger-security','site-palettes','stock-chart-controls','workspace-background'];
files.unshift('analysis-orders','fx-refresh-command', 'position-valuation', 'task-observation','stock-icon-requests','migration-resume','system-task-presentation','order-time','migration-history-display','material-image-upload', 'interface-checks', 'system-media', 'admin-proof', 'visible-polling', 'account-menu-refresh');
for (const name of files) {
 console.log('\nTEST '+name);
 const result=spawnSync(process.execPath,['tests/'+name+'.cjs'],{stdio:'inherit'});
 if(result.status!==0)process.exit(result.status??1);
}
