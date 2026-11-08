"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowRight, IconDatabase, IconEdit, IconRefresh,IconCheck,IconCircle,IconLoader2,IconAlertCircle } from "@tabler/icons-react";
import { Capsule, IconButton } from "@/components/Capsule";
import AppSelect from "@/components/AppSelect";
import PasswordInput from "@/components/PasswordInput";
import { requestAdminProof } from "@/lib/adminProof";
import { appConfirm } from "@/lib/appDialog";
import PlatformBackups from "@/components/PlatformBackups";
import { platformRequest as request, PlatformRequestError } from "@/lib/platformRequest";
import { useWorkspaceActive, useWorkspaceSearchParams, useWorkspaceLocationGuard } from "@/lib/workspacePanel";
import type { MigrationConnectionData, MigrationConnectionCheck, MigrationSourceConfig,MigrationPreparationTask } from "@/lib/databaseMigration";
import type { WorkspaceInitial, WebSession } from "@/lib/workspaceInitial";

const empty: MigrationSourceConfig = { host: "", port: 5432, database: "", username: "", schema_name: "public", ssl_mode: "disable" };
type Listing = { items: { id: string; created_at: string; bytes: number; sha256: string; verified_at: string | null; download_available: boolean }[]; configured: boolean; key_fingerprint: string | null };
type Initial = { identity: WebSession; connections: MigrationConnectionData; backups: Listing; preparations:MigrationPreparationTask[]; preparation?:MigrationPreparationTask };
export type BackupRecoveryInitial = Initial;
const validUuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export default function BackupRecoveryView({ ownerId, initial, initialNow }: {
  ownerId: string; initial?: WorkspaceInitial["backupRecovery"]; initialNow: number;
}) {
  const active = useWorkspaceActive(), params = useWorkspaceSearchParams(), canUseLocation = useWorkspaceLocationGuard();
  const seed = initial?.identity.user.id === ownerId ? initial : undefined;
  const sourceRequestFromUrl=params.get('sourceRequest')||'';
  const migrationRequestFromUrl=params.get('migrationRequest')||'';
  const [data, setData] = useState<MigrationConnectionData | null>(seed?.connections ?? null);
  const [listing, setListing] = useState<Listing | null>(seed?.backups ?? null);
  const [source, setSource] = useState<MigrationSourceConfig>(seed?.connections.source?.config ?? empty);
  const [portDraft,setPortDraft]=useState(String(seed?.connections.source?.config.port??5432));
  const [editing, setEditing] = useState(!seed?.connections.source), [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false), [busy, setBusy] = useState("");
  const [error, setError] = useState(""), [verify, setVerify] = useState(false);
  const [now, setNow] = useState(initialNow);
  const [visible, setVisible] = useState(true);
  const [unknown, setUnknown] = useState(validUuid(sourceRequestFromUrl)?sourceRequestFromUrl:'');
  const [task,setTask]=useState<MigrationPreparationTask|null>(seed?.preparation ?? null);
  const [preparations,setPreparations]=useState<MigrationPreparationTask[]>(seed?.preparations??[]);
  const [preparationRequest,setPreparationRequest]=useState(validUuid(migrationRequestFromUrl)?migrationRequestFromUrl:seed?.preparation?.request_id ?? '');
  const [failed, setFailed] = useState({ source: false, target: false });
  const identity = useRef<WebSession | null>(seed?.identity ?? null), first = useRef(!!seed), generation = useRef(0);
  const sourceRevision = useRef(seed?.connections.source?.revision);
  const draftRevision = useRef<string|null>(seed?.connections.source?.revision??null);
  const lifetime = useRef<AbortController | null>(null), pending = useRef(false), reads = useRef(0);
  const tab = params.get("tab") === "migration" ? "migration" : "backups";
  const url = useCallback((key: string, value: string) => {
    if (!canUseLocation()) return;
    const next = new URL(window.location.href);
    if (value) next.searchParams.set(key, value); else next.searchParams.delete(key);
    window.history.replaceState(null, "", next);
  }, [canUseLocation]);
  const headers = () => ({ "content-type": "application/json", "x-csrf-token": identity.current?.csrf ?? "" });
  const retire = useCallback(() => {
    identity.current = null; setData(null); setListing(null); setSource(empty); setPassword("");
    setVerify(false); setUnknown("");setTask(null);setPreparationRequest('');setPreparations([]);
    if (active) window.location.reload();
  }, [active]);
  const load = useCallback(async (signal: AbortSignal, refreshDraft = false) => {
    const ticket = ++reads.current;
    const session = await request<WebSession>("/api/fire/session", { signal });
    if (signal.aborted || ticket !== reads.current) return;
    if (session.user.id !== ownerId || session.user.role !== "admin" || identity.current && session.instance_id !== identity.current.instance_id) { retire(); return; }
    identity.current = session;
    const [connections, backups,history] = await Promise.all([
      request<MigrationConnectionData>("/api/fire/database-migration/connections", { signal, headers: { "x-csrf-token": session.csrf } }),
      request<Listing>("/api/fire/backups", { signal, headers: { "x-csrf-token": session.csrf } }),
      request<{items:MigrationPreparationTask[]}>("/api/fire/database-migration/preparations",{signal,headers:{'x-csrf-token':session.csrf}}),
    ]);
    if (signal.aborted || ticket !== reads.current) return;
    if (sourceRevision.current !== connections.source?.revision) setFailed(value => ({ ...value, source: false }));
    sourceRevision.current = connections.source?.revision;
    setData(connections); setListing(backups);setPreparations(history.items);
    if (refreshDraft) { draftRevision.current=connections.source?.revision??null; setSource(connections.source?.config ?? empty);setPortDraft(String(connections.source?.config.port??5432)); setEditing(!connections.source); setPassword(""); setClearPassword(false); }
  }, [ownerId, retire]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); lifetime.current = controller;
    const fromUrl = params.get("sourceRequest") || "";
    if (validUuid(fromUrl)) setUnknown(fromUrl);
    const preparationFromUrl=params.get('migrationRequest')||'';
    if(validUuid(preparationFromUrl))setPreparationRequest(preparationFromUrl);
    if (first.current) first.current = false;
    else void load(controller.signal, !editing||!data).catch(e => {
      if(controller.signal.aborted)return;
      const failure=e as PlatformRequestError;
      if(failure.status===401||failure.status===403)retire();else setError(failure.message);
    });
    const hidden = () => { setVisible(!document.hidden); if (document.hidden) { setPassword(""); } else setNow(Date.now()); };
    setVisible(!document.hidden);
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 15000);
    document.addEventListener("visibilitychange", hidden);
    return () => { controller.abort(); generation.current++; reads.current++; pending.current = false; setBusy(""); setPassword(""); clearInterval(timer); document.removeEventListener("visibilitychange", hidden); };
  // Tab changes retain the same live operation and never replay it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ownerId, load]);

  useEffect(()=>{
    if(!active||!validUuid(migrationRequestFromUrl))return;
    setPreparationRequest(migrationRequestFromUrl);
    setTask(current=>current?.request_id===migrationRequestFromUrl?current:null);
  },[active,migrationRequestFromUrl]);

  useEffect(()=>{
    if(!active||tab!=='migration'||!preparationRequest)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let checking=false;
    async function poll(){
      if(checking||controller.signal.aborted)return;
      clearTimeout(timer);
      if(document.hidden||!identity.current?.csrf){timer=setTimeout(poll,2500);return;}
      checking=true;
      try{
        const receipt=await request<MigrationPreparationTask>('/api/fire/tasks/receipts/'+preparationRequest,{signal:controller.signal,headers:{'x-csrf-token':identity.current.csrf}});
        if(receipt.request_id!==preparationRequest||receipt.kind!=='database.migration.prepare')throw new Error('原请求不是数据库迁移准备任务');
        const detail=await request<MigrationPreparationTask>('/api/fire/tasks/'+receipt.id,{signal:controller.signal,headers:{'x-csrf-token':identity.current.csrf}});
        if(controller.signal.aborted)return;
        if(detail.request_id!==preparationRequest||detail.kind!=='database.migration.prepare')throw new Error('迁移任务回执不匹配');
        setTask(value=>({...detail,source_revision:detail.result?.source_revision??value?.source_revision}));
        setPreparations(value=>value.map(item=>item.id===detail.id?{...item,...detail}:item));
        if(!['queued','running','cancel_requested'].includes(detail.status))return;
      }catch(error){
        if(controller.signal.aborted)return;
        const failure=error as PlatformRequestError;
        if(failure.status===401||failure.status===403){retire();return;}
        if(failure.status!==404)setError(failure.message);
      }finally{checking=false;}
      if(!controller.signal.aborted)timer=setTimeout(poll,2500);
    }
    const wake=()=>{if(!document.hidden)void poll();};
    void poll();document.addEventListener('visibilitychange',wake);
    return()=>{controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',wake);};
  },[active,tab,preparationRequest,ownerId,retire]);

  async function run(label: string, work: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current) return;
    const ticket = ++generation.current; pending.current = true; setBusy(label); setError("");
    try { await work(signal); }
    catch (e) {
      if (!signal.aborted && ticket === generation.current) {
        const failure = e as PlatformRequestError; setError(failure.message);
        if (failure.reauthentication) setVerify(true);
        else if (failure.status === 401 || failure.status === 403) retire();
      }
    } finally { if (ticket === generation.current) { pending.current = false; setBusy(""); } }
  }
  async function testTarget() {
    await run("target", async signal => {
      setFailed(value => ({ ...value, target: false }));
      let check: MigrationConnectionCheck;
      try { check = await request<MigrationConnectionCheck>("/api/fire/database-migration/target/test", { method: "POST", signal, headers: headers() }); }
      catch (error) { if (!signal.aborted && !(error as PlatformRequestError).reauthentication) setFailed(value => ({ ...value, target: true })); throw error; }
      if (!signal.aborted) { setNow(Date.now()); setData(value => value ? { ...value, checks: { ...value.checks, target: check } } : value); }
    });
  }
  async function testSource() {
    if (!data?.source) return;
    const revision = data.source.revision;
    await run("source", async signal => {
      setFailed(value => ({ ...value, source: false }));
      let check: MigrationConnectionCheck;
      try { check = await request<MigrationConnectionCheck>("/api/fire/database-migration/source/test", { method: "POST", signal, headers: headers(), body: JSON.stringify({ revision }) }); }
      catch (error) { if (!signal.aborted && !(error as PlatformRequestError).reauthentication) setFailed(value => ({ ...value, source: true })); throw error; }
      if (!signal.aborted) { setNow(Date.now()); setData(value => value?.source?.revision === revision ? { ...value, checks: { ...value.checks, source: check } } : value); }
    });
  }
  async function saveSource() {
    if (unknown) return;
    const id = crypto.randomUUID();
    await run("save", async signal => {
      let committed = false;
      url("sourceRequest", id);
      try {
        await request("/api/fire/database-migration/source", { method: "PUT", signal, headers: headers(), body: JSON.stringify({
          request_id: id, expected_revision: draftRevision.current, config: source,
          password_mode: clearPassword ? "clear" : password ? "replace" : "keep", ...(password && !clearPassword ? { password } : {}),
        }) });
        committed = true;
        if (signal.aborted) return;
        url("sourceRequest", ""); setPassword(""); setFailed(value => ({ ...value, source: false }));
        await load(signal, true);
      } catch (e) {
        if (signal.aborted) return;
        const status = (e as PlatformRequestError).status;
        if (!committed && (!status || status >= 500)) { setUnknown(id); setPassword(""); }
        else url("sourceRequest", "");
        throw e;
      }
    });
  }
  async function resolve() {
    await run("receipt", async signal => {
      await request("/api/fire/database-migration/source/operations/" + unknown, { signal, headers: headers() });
      if (signal.aborted) return;
      setUnknown(""); url("sourceRequest", ""); await load(signal, true);
    });
  }
  async function cancelSave() {
    if (!unknown) return;
    await run('cancel-save', async signal => {
      await request('/api/fire/database-migration/source/operations/' + unknown + '/cancel', { method: 'POST', signal, headers: headers() });
      if (signal.aborted) return;
      setUnknown(''); url('sourceRequest', ''); await load(signal, true);
    });
  }
  async function prepare(){
    if(!data?.source)return;
    const requestId=crypto.randomUUID(),revision=data.source.revision;
    await run('prepare',async signal=>{
      setTask(null);setPreparationRequest(requestId);url('migrationRequest',requestId);
      try{
        const accepted=await request<MigrationPreparationTask>('/api/fire/database-migration/preparations',{method:'POST',headers:headers(),signal,body:JSON.stringify({request_id:requestId,source_revision:revision})});
        if(signal.aborted)return;
        if(accepted.request_id!==requestId||accepted.kind!=='database.migration.prepare')throw new Error('迁移准备回执不匹配，请查询原任务');
        setTask(accepted);
        setPreparations(value=>[accepted,...value.filter(item=>item.id!==accepted.id)].slice(0,20));
      }catch(error){
        const status=(error as PlatformRequestError).status;
        if(status&&status<500&&!signal.aborted){setPreparationRequest('');url('migrationRequest','');}
        throw error;
      }
    });
  }
  async function cancelPreparation(){
    if(!preparationRequest)return;
    await run('cancel',async signal=>{
      const cancelled=await request<MigrationPreparationTask>('/api/fire/database-migration/preparations/cancel',{method:'POST',headers:headers(),signal,body:JSON.stringify({request_id:preparationRequest})});
      if(!signal.aborted){setTask(value=>value?{...value,...cancelled,events:value.events}:cancelled);setPreparations(value=>[cancelled,...value.filter(item=>item.id!==cancelled.id)].slice(0,20));}
    });
  }
  const fresh = (check?: MigrationConnectionCheck | null) => check?.state === 'connected' && now - Date.parse(check.observed_at) >= -5000 && now - Date.parse(check.observed_at) < 120000;
  const sourceCheck = data?.checks.source?.revision === data?.source?.revision ? data?.checks.source : null;
  const sourceReady = !editing && !failed.source && busy !== 'source' && fresh(sourceCheck), targetReady = !failed.target && busy !== 'target' && fresh(data?.checks.target);
  const checking = active && (busy === "source" || busy === "target");
  function status(scope: 'source' | 'target', check: MigrationConnectionCheck | null | undefined, connected: boolean) {
    const failure = failed[scope] || check?.state === 'failed';
    return <span className="migration-connection-status" data-connected={connected} data-error={failure} title={check?.observed_at}>
      <span aria-hidden="true" />{busy === scope ? '检查中' : failure ? '连接失败' : connected ? check?.persistent_identity_verified===false ? '已连接 · 身份待核对' : `已连接 · ${check?.response_ms} ms` : check ? "待重新检测" : "未检测"}
    </span>;
  }
  const preparationActive=!!preparationRequest&&(!task||['queued','running','cancel_requested'].includes(task.status));
  const anyPreparationActive=preparationActive||preparations.some(item=>['queued','running','cancel_requested'].includes(item.status));
  const disabled = !!busy || !!unknown || !data || anyPreparationActive;
  async function refresh(){
    await run('read',async signal=>{
      const dirty=editing&&(!!password||clearPassword||JSON.stringify(source)!==JSON.stringify(data?.source?.config??empty));
      if(dirty&&!await appConfirm('重新读取将放弃当前连接草稿。',{title:'重新读取连接'}))return;
      if(!signal.aborted)await load(signal,true);
    });
  }
  return <section className="backup-recovery-view">
    <div className="flex items-center justify-between gap-4"><h1 className="text-2xl font-semibold text-ink">备份与恢复</h1>
      <IconButton label="重新读取" busy={busy === "read"} disabled={!!busy || !!unknown} onClick={() => void refresh()}><IconRefresh size={20} /></IconButton>
    </div>
    <div className="mt-6 flex gap-2" role="tablist" aria-label="备份与恢复">
      {([['backups','备份'],['migration','数据库迁移']] as const).map(([key,label]) => <Capsule key={key} role="tab" aria-selected={tab === key} variant={tab === key ? "primary" : "secondary"} onClick={() => url("tab",key)}>{label}</Capsule>)}
    </div>
    {error && <p className="mt-4 text-red-500" role="alert">{error}</p>}
    {verify && <div className="mt-4"><Capsule variant="secondary" busy={busy==='verify'} disabled={!!busy} onClick={()=>void run('verify',async signal=>{
      const proof=await requestAdminProof();
      if(!proof||signal.aborted)return;
      await request('/api/fire/connections/reauthenticate',{method:'POST',signal,headers:headers(),body:JSON.stringify(proof)});
      if(!signal.aborted){setVerify(false);setError('');}
    })}>验证身份</Capsule></div>}
    {unknown && <div className="mt-4 flex flex-wrap items-center gap-3"><span className="text-ink-2">保存结果待核对</span><Capsule variant="secondary" busy={busy === "receipt"} disabled={!!busy} onClick={() => void resolve()}>查询原回执</Capsule><Capsule variant="secondary" busy={busy==='cancel-save'} disabled={!!busy} onClick={()=>void cancelSave()}>取消未完成请求</Capsule></div>}
    {tab === "backups" ? <div className="mt-6 rounded-3xl border border-edge bg-white p-6">
      <div className="flex flex-wrap items-center justify-between gap-4"><h2 className="text-lg font-semibold text-ink">完整备份</h2><PlatformBackups ownerId={ownerId} buttonOnly onClose={()=>void run('read',signal=>load(signal))}/></div>
      <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-ink-3"><tr><th className="py-3">创建时间</th><th>大小</th><th>校验状态</th><th>SHA-256</th></tr></thead><tbody>
        {listing?.items.map(item => <tr key={item.id} className="border-t border-edge"><td className="py-4"><time dateTime={item.created_at}>{item.created_at.slice(0,19).replace('T',' ')} UTC</time></td><td>{(item.bytes / 1048576).toFixed(1)} MB</td><td>{item.verified_at ? "已校验" : "待校验"}</td><td><code title={item.sha256}>{item.sha256.slice(0,12)}</code></td></tr>)}
        {listing && !listing.items.length && <tr><td colSpan={4} className="py-10 text-center text-ink-3">暂无备份</td></tr>}
      </tbody></table></div>
    </div> : <><div className="migration-connections mt-6" data-active={active && visible}>
      <div className="migration-database-card">
        <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><IconDatabase size={22} /><h2 className="text-lg font-semibold">旧数据库</h2></div>
          {!editing && <IconButton label="编辑旧库连接" disabled={disabled} onClick={() => { reads.current++; draftRevision.current=data?.source?.revision??null; setSource(data?.source?.config ?? empty);setPortDraft(String(data?.source?.config.port??5432)); setPassword(""); setClearPassword(false); setEditing(true); }}><IconEdit size={18} /></IconButton>}
        </div>
        {editing ? <form className="mt-6" onSubmit={event => { event.preventDefault(); void saveSource(); }}>
          <div className="migration-connection-fields">
            {([['host','地址'],['port','端口'],['database','数据库'],['schema_name','Schema'],['username','账号']] as const).map(([key,label]) => <label key={key} className="grid gap-2 text-sm text-ink-3">{label}<input required disabled={disabled} autoComplete="off" type={key === 'port' ? 'number' : 'text'} min={key === 'port' ? 1 : undefined} max={key === 'port' ? 65535 : undefined} maxLength={key === 'port' ? undefined : key === 'schema_name' ? 63 : key==='host'?253:128} value={key==='port'?portDraft:source[key]} onChange={event => {if(key==='port')setPortDraft(event.target.value);setSource(value => ({ ...value, [key]: key === 'port' ? Number(event.target.value) : event.target.value }));}} /></label>)}
            <label className="grid gap-2 text-sm text-ink-3">{data?.source?.password_configured ? "密码（已配置）" : "密码"}<PasswordInput value={password} maxLength={1024} autoComplete="new-password" disabled={disabled || clearPassword} onChange={event => setPassword(event.target.value)} /></label>
            <label className="grid gap-2 text-sm text-ink-3">连接加密<AppSelect value={source.ssl_mode ?? "disable"} disabled={disabled} ariaLabel="旧库连接加密" options={[{ value:'disable',label:'不启用' },{ value:'require',label:'TLS' },{ value:'verify-ca',label:'TLS · 验证证书' },{ value:'verify-full',label:'TLS · 验证证书与主机' }]} onChange={value => setSource(current => ({ ...current, ssl_mode: value as MigrationSourceConfig['ssl_mode'] }))} /></label>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={clearPassword} disabled={disabled} onChange={event => { setClearPassword(event.target.checked); setPassword(""); }} />不使用密码</label>
          <div className="mt-4 flex flex-wrap justify-end gap-3">{data?.source && <Capsule variant="secondary" disabled={disabled} onClick={() => { setEditing(false); setPassword(""); }}>取消</Capsule>}<Capsule type="submit" busy={busy === "save"} disabled={disabled}>保存连接</Capsule></div>
        </form> : <><ConnectionFields config={data?.source?.config} passwordConfigured={data?.source?.password_configured} />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">{status('source',sourceCheck,sourceReady)}<Capsule variant="secondary" busy={busy === "source"} disabled={disabled || !data?.source} onClick={() => void testSource()}>测试连接</Capsule></div>
        </>}
      </div>
      <div className="migration-connection-flow" data-state={checking ? "checking" : sourceReady && targetReady ? "connected" : "idle"} aria-label={checking ? "正在检查连接" : sourceReady && targetReady ? "两边连接检查通过" : "等待连接检查"}>
        <span className="migration-flow-line" /><IconArrowRight size={24} aria-hidden="true" />
      </div>
      <div className="migration-database-card"><div className="flex items-center gap-3"><IconDatabase size={22} /><h2 className="text-lg font-semibold">新数据库</h2></div>
        <ConnectionFields config={data?.target.config} passwordConfigured={data?.target.password_configured} />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">{status('target',data?.checks.target,targetReady)}<Capsule variant="secondary" busy={busy === "target"} disabled={disabled || !data} onClick={() => void testTarget()}>测试连接</Capsule></div>
      </div>
    </div>
      <div className="mt-4 flex justify-end"><Capsule disabled={disabled||!sourceReady||!targetReady||!sourceCheck?.persistent_identity_verified||!data?.checks.target?.persistent_identity_verified} busy={busy==='prepare'} onClick={()=>void prepare()}>准备迁移</Capsule></div>
      {!!preparations.length&&<div className="mt-6 flex flex-wrap items-center gap-3"><span className="text-sm text-ink-3">准备记录</span><AppSelect ariaLabel="准备记录" value={preparationRequest} options={preparations.map(item=>({value:item.request_id,label:`${item.created_at?.slice(0,19).replace('T',' ')??item.request_id.slice(0,8)} · ${item.status==='succeeded'&&item.result?.source?.restore_verified&&item.result.target?.restore_verified?'恢复核对通过':{queued:'等待中',running:'进行中',succeeded:'归档已校验',failed:'失败',cancelled:'已取消',cancel_requested:'取消中'}[item.status]}`}))} onChange={value=>{const selected=preparations.find(item=>item.request_id===value);if(selected){setTask(selected);setPreparationRequest(value);url('migrationRequest',value);}}} /></div>}
      {preparationRequest&&<><PreparationProgress task={task} requestId={preparationRequest} moving={active&&visible} busy={!!busy} onCancel={()=>void cancelPreparation()}/>{(task?.source_revision??task?.result?.source_revision)&&data?.source?.revision!==(task?.source_revision??task?.result?.source_revision)&&<p className="mt-3 text-sm text-ink-3">此记录对应旧版本连接配置</p>}</>}
    </>}
  </section>;
}

const preparationPhases=[['source_archive','旧库备份'],['source_rows','旧库逐表副本'],['source_verify','旧库归档校验'],['target_archive','新库备份'],['target_rows','新库逐表副本'],['target_verify','新库归档校验'],['source_restore','隔离恢复旧库'],['source_reconcile','核对旧库内容'],['target_restore','隔离恢复新库'],['target_reconcile','核对新库内容']] as const;
function PreparationProgress({task,requestId,moving,busy,onCancel}:{task:MigrationPreparationTask|null;requestId:string;moving:boolean;busy:boolean;onCancel:()=>void}){
  const completed=task?.status==='succeeded'&&task.result?.phase==='awaiting_mapping'&&task.result.source?.restore_verified&&task.result.target?.restore_verified;
  const phases=preparationPhases.map(([key])=>key as string);
  const last=task?.result?.progress?.phase??task?.events?.filter(event=>phases.includes(event.phase)).at(-1)?.phase;
  const index=completed?phases.length:Math.max(0,phases.indexOf(last??''));
  const active=task?.status==='running',failed=task?.status==='failed',cancelled=task?.status==='cancelled';
  const progress=task?.result?.progress;
  const percentage=progress?.total&&progress.total>0?Math.max(0,Math.min(100,progress.processed/progress.total*100)):null;
  const label=completed?'双库恢复核对通过 · 待数据转换':failed?'准备失败':cancelled?'已取消':task?.status==='cancel_requested'?'取消中':task?.status==='queued'?'等待执行':active?'正在准备':'正在核对原任务';
  const message=task?.result?.message;
  const expectedCancellation=cancelled&&(message==='迁移准备已停止'||message==='迁移准备已停止或执行权已变化');
  return <div className="migration-preparation mt-6" data-moving={moving&&active}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold text-ink">{label}</h2>{(!task||['queued','running'].includes(task.status))&&<Capsule variant="secondary" size="sm" disabled={busy} onClick={onCancel}>取消准备</Capsule>}</div>
    <ol className="migration-phase-list mt-5">{preparationPhases.map(([key,title],position)=>{
      const state=position<index?'complete':position===index&&failed?'failed':position===index&&active?'running':'pending';
      return <li key={key} data-state={state}><span className="migration-phase-icon">{state==='complete'?<IconCheck size={18}/>:state==='failed'?<IconAlertCircle size={18}/>:state==='running'?<IconLoader2 size={18}/>:<IconCircle size={18}/>}</span><span>{title}</span>{state==='running'&&progress?.phase===key&&progress.total!==null&&<small>{progress.processed} / {progress.total}</small>}</li>;
    })}</ol>
    {active&&percentage!==null&&<div className="migration-stage-progress" role="progressbar" aria-label="当前阶段进度" aria-valuenow={Math.round(percentage)} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${percentage}%`}}/></div>}
    {message&&!expectedCancellation&&<p className="mt-4 text-sm text-red-500" role="alert">{message}</p>}
    {completed&&<dl className="mt-5 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-ink-3">旧库</dt><dd className="mt-1 text-ink">{task?.result?.source?.tables} 张表 · {task?.result?.source?.rows} 条记录</dd></div><div><dt className="text-ink-3">新库</dt><dd className="mt-1 text-ink">{task?.result?.target?.tables} 张表 · {task?.result?.target?.rows} 条记录</dd></div></dl>}
    <details className="mt-4 text-xs text-ink-3"><summary>操作回执</summary><code className="mt-2 block break-all">{requestId}</code></details>
  </div>;
}

function ConnectionFields({ config, passwordConfigured }: { config?: MigrationSourceConfig; passwordConfigured?: boolean }) {
  return <dl className="migration-connection-fields mt-6">{([['地址',config?.host],['端口',config?.port],['数据库',config?.database],['Schema',config?.schema_name],['账号',config?.username],['密码',passwordConfigured ? '已配置' : '未配置']] as const).map(([label,value]) => <div key={label} className="min-w-0"><dt className="text-sm text-ink-3">{label}</dt><dd className="mt-2 break-words text-ink">{value ?? '—'}</dd></div>)}</dl>;
}
