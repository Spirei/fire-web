import {notFound,redirect} from 'next/navigation';
import {headers} from 'next/headers';
import Link from 'next/link';
import {getSiteSettingsSnapshot} from '@/lib/settings';
import {getWebSession,isAdmin,needsSetup} from '@/lib/auth';
import {workspaceBootstrap} from '@/lib/workspaceBootstrap';
import type {WorkspaceInitial} from '@/lib/workspaceInitial';
import {platformJson} from '@/lib/platformTransport';
import type {StockRecord} from '@/lib/types';
import GlobalSearchTrigger from '@/components/GlobalSearchTrigger';
import RecordsApp from '@/components/RecordsApp';
import UserMenu from '@/components/UserMenu';
import SiteLogo from '@/components/SiteLogo';
import WorkspaceTicker from '@/components/WorkspaceTicker';
import Toaster from '@/components/Toaster';
import {CurrencyProvider,type CurrencyCode} from '@/lib/currencyPrefs';
import {displayCurrencyFlagCode} from '@/lib/flagAssets';
import {CURRENT_VERSION} from '@/lib/versions';
export const dynamic='force-dynamic';
export default async function WorkspacePage({params,searchParams}:{params:Promise<{slug?:string[]}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const path='/'+((await params).slug||[]).join('/');
  if(path==='/attachments'||path.startsWith('/api/attachments'))notFound();
  const values=await searchParams;
  const query=new URLSearchParams();
  for(const [key,value]of Object.entries(values))if(typeof value==='string')query.set(key,value);
  const initialNow=Date.now();
  const requestHeaders=await headers();
  const rawCookie=requestHeaders.get('cookie')||'';
  const [identity,settingsSnapshot]=await Promise.all([getWebSession(rawCookie),getSiteSettingsSnapshot()]);
  const settings=settingsSnapshot.settings;
  if(!identity)redirect(await needsSetup()?'/setup':'/login');
  const user=identity.user;
  const system={'system-overview':'系统总览','background-tasks':'后台任务','backup-recovery':'备份与恢复','api-migration':'API 接口'};
  const systemKey=path.slice(1) as keyof typeof system;
  const specialTab=system[systemKey]?{key:systemKey}:path==='/quote-pool'?{key:'quote-pool'}:path==='/asset-pnl-analysis'?{key:'pnl'}:null;
  if(system[systemKey]&&!isAdmin(user))notFound();
  let tab=specialTab??settings.tabs.find(t=>(t.url||`/${t.key}`)===path);
  let initialSymbol:string|undefined;
  if(!tab){const base=settings.tabs.find(t=>t.key==='watchlist');const baseUrl=base?.url||'/watchlist';if(path.startsWith(baseUrl+'/')){const code=path.slice(baseUrl.length+1);if(/^[A-Za-z]{2,5}\.[A-Z0-9._-]+$/.test(code)){tab=base;initialSymbol=code.toUpperCase();}}}
  if(!tab)notFound();
  const cookieHeaders={cookie:rawCookie};
  const financial=['holdings','watchlist','assets','pnl','fire','earnings','global'].includes(tab.key) || tab.key==='settings'&&query.get('sub')==='profile'&&['data','danger'].includes(query.get('anchor')||'');
  const [initialRecords,funds,initialWorkspace]=await Promise.all([
    financial?platformJson<StockRecord[]>('/api/records',cookieHeaders):Promise.resolve([]),
    ['holdings','global'].includes(tab.key)?platformJson<{balances:Record<string,number|null>}>('/api/fire/funds',cookieHeaders):Promise.resolve({balances:{}}),
    workspaceBootstrap(tab.key,query,identity,path=>platformJson(path,cookieHeaders,{signal:AbortSignal.timeout(8000)})).catch(()=>({} as WorkspaceInitial))
  ]);
  const initialFundBalances=funds.balances;
  const currencyCookie=rawCookie.split(';').map(p=>p.trim()).find(p=>p.startsWith('fire-display-currency='))?.split('=')[1] as CurrencyCode|undefined;
  const currencyFlagCode=displayCurrencyFlagCode(currencyCookie);
  const celebAvatars:Record<string,string>={};
  const initialQuotePool=initialWorkspace.quotePool,initialAssetLibrary=null,initialCardLibrary=initialWorkspace.cards,initialCelebs=initialWorkspace.celebs,initialFeed=initialWorkspace.feed;
  const initialWatchGroups=initialWorkspace.watchGroups ?? [];
  const initialUserLogs=initialWorkspace.logs?.userLogs ?? [];
  const initialStockIcons={},initialMarketIcons={},initialNavIcons={};
  const initialFlagIcons:Record<string,string>={};
  const initialAvatar=user.avatar;
  const initialCardCovers:string[]=[];
  return (
    <div className="app-shell-root flex min-h-[100dvh] flex-col bg-page">
      {tab.key === "settings" && <link rel="preload" as="image" href="/api/system-assets/passkey" />}
      {/* 只有名人持仓需要这组头像。 */}
      {tab.key === "celebs" &&
        Object.values(celebAvatars)
          .filter(Boolean)
          .map((u) => <link key={u} rel="preload" as="image" href={u} fetchPriority="high" />)}
      {initialFlagIcons[currencyFlagCode] && !initialFlagIcons[currencyFlagCode].startsWith("data:") && <link rel="preload" as="image" href={initialFlagIcons[currencyFlagCode]} />}
      {initialCardCovers.map((url) => <link key={url} rel="preload" as="image" href={url} />)}
      <Toaster />
      <header className="app-shell-header site-header sticky top-0 z-50 h-[72px] border-b border-edge/80">
        <div className="app-shell-header-inner mx-auto flex h-full max-w-[1140px] items-center gap-5 px-6">
          <Link href="/" className="inline-flex flex-none items-center gap-2.5 hover:opacity-90">
            <SiteLogo initialLogo={settings.siteLogo} initialText={settings.logoText} initialFont={settings.logoFont} />
          </Link>
          <WorkspaceTicker />
          <div className="workspace-header-account ml-auto flex flex-none items-center gap-2.5">
            <GlobalSearchTrigger />
            <UserMenu initialUser={user} initialAvatar={initialAvatar} />
          </div>
        </div>
      </header>

      <main className="app-shell-main flex-1 py-14">
        <CurrencyProvider initialCurrency={currencyCookie ?? null}>
        <RecordsApp
          key={user.id}
          initialWorkspace={initialWorkspace}
          initialTab={tab.key}
          initialNow={initialNow}
          initialVersion={CURRENT_VERSION.version}
          initialSymbol={initialSymbol}
          initialCelebAvatars={celebAvatars}
          initialCelebs={initialCelebs}
          initialUser={user}
          initialRecords={initialRecords}
          initialRecordsReady={financial}
          initialWatchGroups={initialWatchGroups}
          initialUserLogs={initialUserLogs}
          initialPasskeys={tab.key === "settings" ? null : null}
          initialFundBalances={initialFundBalances}
          initialStockIcons={initialStockIcons}
          initialMarketIcons={initialMarketIcons}
          initialNavIcons={initialNavIcons}
          initialFlagIcons={initialFlagIcons}
          initialAssetLibrary={initialAssetLibrary}
          initialCardLibrary={initialCardLibrary}
          initialFeed={initialFeed}
          initialQuotePool={initialQuotePool}
          initialSettings={settings}
          initialSettingsVersion={settingsSnapshot.version}
        />
        </CurrencyProvider>
      </main>


    </div>
  );
}
