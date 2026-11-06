// Execute captured source with memory-only file/database boundaries.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
let stored=null,filter=null;
const db={prepare(sql){return {
 run(...v){if(sql.startsWith('INSERT'))stored={id:v[0],market:v[1],exchange:v[2],company_code:v[3],company_name:v[4],fiscal_year:v[5],fiscal_period:v[6],report_type:v[7],file_kind:v[8],file_name:v[9],file_url:v[10],mime_type:v[11],file_size:v[12],source:'manual',schema_version:'1.0',created_at:v[14]};},
 get(){return stored;},all(...values){filter={sql,values};return stored?[stored]:[];}
}}};
const context=vm.createContext({Buffer,File,Date,process:{cwd:()=>'/synthetic-project'}});
const mod=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(process.argv[2],'utf8'),{mode:'transform'}),{context});
(async()=>{const deps={fs:{default:{mkdirSync(){},writeFileSync(){},rmSync(){}}},path:{default:path},crypto:{randomBytes:n=>Buffer.alloc(n)},'./db':{getDb:()=>db}};
await mod.link(name=>new vm.SyntheticModule(Object.keys(deps[name]),function(){for(const key of Object.keys(deps[name]))this.setExport(key,deps[name][key]);},{context}));await mod.evaluate();
const m=mod.namespace,out={segments:[],errors:[]};
for(const value of [' us ','NAS.DAQ','DEMO','FY','../unsafe','x/y','']){try{out.segments.push([value,m.safeSegment(value,'市场')]);}catch(e){out.errors.push([value,e.message]);}}
out.report=await m.saveFinancialReportFile({file:new File(['synthetic'],'Synthetic.pdf'),market:'us',exchange:'nasdaq',code:'demo',companyName:' Synthetic company ',fiscalYear:2026,fiscalPeriod:'fy',reportType:' Annual ',userId:'synthetic-u'});
out.list=m.listFinancialReportFiles({market:' us ',exchange:'nasdaq',code:'demo'});out.filter=filter;
console.log(JSON.stringify(out));})().catch(e=>{console.error(e.stack||e);process.exit(1)});
