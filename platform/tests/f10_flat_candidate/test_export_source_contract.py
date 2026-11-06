"""Execute the frozen old export route without SQLite, network or business IO."""
import json
import subprocess

from alcor_api.legacy_order_workbooks import DETAIL, HEADERS
from frozen_legacy import source_root


def test_frozen_old_route_workbook_columns_are_preserved():
    root=source_root('ALCOR_MARKET_LEGACY_ROOT', ['app/api/v1/orders/export/route.ts'])
    source=root/'app/api/v1/orders/export/route.ts'
    assert source.is_file(),'Explicit read-only legacy source required'
    script=r'''
const fs=require('fs'),vm=require('vm'),ts=require('typescript');
let captured;
const stubs={
 '@/lib/auth':{getAuthUser:()=>({id:'synthetic-owner'})},
 '@/lib/api':{fail:()=>{throw Error('unexpected failure')}},
 '@/lib/orders':{listOrders:()=>[]},
 '@/lib/xlsx':{buildXlsx:sheets=>{captured=sheets;return Buffer.from('synthetic')}},
 '@/lib/stockAccount':{holdingAccountMarket:row=>row.market},
 '@/lib/types':{marketMeta:market=>({label:market,code:market})}
};
const text=fs.readFileSync(process.argv[1],'utf8');
const output=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const context={exports:{},require:name=>{if(!(name in stubs))throw Error(name);return stubs[name]},URL,Response,Uint8Array,Buffer,Date};
vm.runInNewContext(output,context);
(async()=>{const response=await context.exports.GET(new Request('http://synthetic/api/v1/orders/export?detail=1'));if(response.status!==200)throw Error('not 200');process.stdout.write(JSON.stringify(captured.map(s=>({name:s.name,headers:s.headers}))));})().catch(e=>{console.error(e);process.exit(1)});
'''
    run=subprocess.run(['node','-e',script,str(source)],capture_output=True,text=True,timeout=30,check=False)
    assert run.returncode==0,run.stderr
    assert json.loads(run.stdout)==[{'name':'订单','headers':HEADERS},{'name':'订单明细','headers':DETAIL}]
