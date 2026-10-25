const assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript'), Module = require('node:module');
require.extensions['.ts'] = (m, file) => m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const original = Module._load;
let calls=0;
Module._load = function(name,parent,...rest) {
 if (parent?.filename.endsWith('/chartSeries.ts') && name === './futuQuotes') return {fetchFutuMinuteSeries:async()=>[]};
 if (parent?.filename.endsWith('/chartSeries.ts') && name === './settings') return {getSiteSettings:()=>({chartApiUrl:'test'})};
 if (parent?.filename.endsWith('/chartSeries.ts') && name === './net') return {proxyFetch:async()=>{calls++;return new Response(JSON.stringify(wire),{status:200});}};
 return original.call(this,name,parent,...rest);
};
const {parseChartSeries,chartSeriesSymbols,fetchChartSeries,normalizeChartRows}=require('../lib/chartSeries.ts');
const now=Date.parse('2026-10-25T12:00:00Z');
const dates=['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23'];
const stamps=dates.flatMap(d=>[Date.parse(d+'T13:30:00Z')/1000,Date.parse(d+'T19:55:00Z')/1000]);
let wire={chart:{result:[{meta:{symbol:'TSLL'},timestamp:stamps,indicators:{quote:[{close:stamps.map((_,i)=>10+i)}]}}]}};
let result=parseChartSeries(wire,'US','TSLL','TSLL',5,now);
assert.deepEqual([...new Set(result.points.map(p=>p.date))],dates);
assert.equal(result.points[0].time,'09:30'); assert.equal(result.coverage.overnight,false);
assert.equal(new Set(parseChartSeries(wire,'US','TSLL','TSLL',1,now).points.map(p=>p.date)).size,1);
assert.throws(()=>parseChartSeries(wire,'US','AAPL','AAPL',5,now));
assert.throws(()=>parseChartSeries(wire,'US','TSLL','TSLL',5,now-60*86400000));
assert.deepEqual(chartSeriesSymbols('HK','00700'),['0700.HK']);
assert.deepEqual(chartSeriesSymbols('CN','600000'),['600000.SS']);
assert.deepEqual(chartSeriesSymbols('CN','920001'),[]);
const bad=structuredClone(wire);bad.chart.result[0].timestamp.push(stamps[0]);bad.chart.result[0].indicators.quote[0].close.push(999);
assert.equal(parseChartSeries(bad,'US','TSLL','TSLL',5,now).points.length,9);
const nulls=structuredClone(wire);nulls.chart.result[0].indicators.quote[0].close[0]=null;
assert.equal(parseChartSeries(nulls,'US','TSLL','TSLL',5,now).points.length,9);
// Source timestamp chooses the exchange day, not the UTC day; DST differs across seasons.
const boundary={chart:{result:[{meta:{symbol:'TSLL'},timestamp:[Date.parse('2026-01-03T00:00:00Z')/1000,Date.parse('2026-01-03T00:05:00Z')/1000],indicators:{quote:[{close:[10,11]}]}}]}};
const b=parseChartSeries(boundary,'US','TSLL','TSLL',1,Date.parse('2026-01-03T01:00:00Z'));
assert.equal(b.points[0].date,'2026-01-02');assert.equal(b.points[0].time,'19:00');
const overnightStamps=['2026-10-22T00:00:00Z','2026-10-22T07:00:00Z','2026-10-22T13:30:00Z','2026-10-22T23:55:00Z'].map(s=>Date.parse(s)/1000);
const night=normalizeChartRows(overnightStamps,[10,11,12,13],'US','TSLL',1,'futu',now);
assert.equal(night.points.length,4);assert.equal(night.points[0].date,'2026-10-21');assert.equal(night.points[0].time,'20:00');assert.equal(night.coverage.overnight,true);
(async()=>{
 const realNow=Date.now;Date.now=()=>now;
 try { const [a,b]=await Promise.all([fetchChartSeries('US','TSLL',5),fetchChartSeries('US','TSLL',5)]);assert.equal(calls,1);assert.deepEqual(a,b);await fetchChartSeries('US','TSLL',5);assert.equal(calls,1); }
 finally {Date.now=realNow;}
 console.log('chart series: exchange dates, five sessions, identity, future/null/conflict rejection and shared reads passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
