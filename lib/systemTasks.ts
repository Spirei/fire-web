export type SystemTask = {kind:string;status:string;attempts:number;result:unknown};
const titles:Record<string,string>={
 'system.diagnostics':'系统连接检查','database.migration.prepare':'数据库迁移准备','database.migration.convert':'数据转换与校验','database.migration.portfolio':'导入持仓与自选','database.migration.history':'导入交易与资金','database.migration.complete':'完成数据迁移',
 'backup.create':'创建备份','backup.verify':'校验备份','backup.restore':'恢复备份','backup.retention':'备份保留检查',
 'market.latest':'行情更新','market.history':'历史行情采集','alerts.monitor':'价格提醒监测','feed.refresh':'更新动态','feed.source_test':'动态来源检查','feed.discussion':'动态讨论','celeb.sec_collect':'持仓披露采集','asset.source':'素材采集','agent.runtime':'智能任务','dividends.source.import':'股息来源采集','dividends.entitlements.review':'股息权益核对',
};
const states:Record<string,string>={queued:'等待中',running:'运行中',cancel_requested:'取消中',cancelled:'已取消',succeeded:'已完成',failed:'失败'};
export function systemTaskView(task:SystemTask){
 const result=task.result&&typeof task.result==='object'?task.result as Record<string,unknown>:{};
 const recurring=task.kind==='market.latest';
 const page=typeof result.page==='number'&&Number.isSafeInteger(result.page)&&result.page>=0?result.page:0;
 return {title:titles[task.kind]??'后台任务',state:recurring&&task.status==='queued'?(result.state==='sleeping'?'已休眠':page?'等待更新':'等待采集'):recurring&&task.status==='running'?'采集中':states[task.status]??task.status,executions:recurring?Math.max(page,task.attempts):task.attempts};
}
export function finiteTaskCounts(total:Record<string,number>,recurring:Record<string,number>={}){
 return {queued:Math.max(0,(total.queued??0)-(recurring.queued??0)),running:Math.max(0,(total.running??0)-(recurring.running??0)),succeeded:total.succeeded??0,recurring:(recurring.queued??0)+(recurring.running??0)+(recurring.cancel_requested??0)};
}
