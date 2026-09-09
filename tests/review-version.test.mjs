import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'review-version-'));
const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'4187',DATA_ROOT:dir},stdio:['ignore','pipe','inherit']});
try {
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
 async function api(path,method='GET',body){const r=await fetch('http://localhost:4187'+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
 const project=(await api('/api/projects','POST',{name:'Regression fixture'})).data;
 const path='/api/projects/'+project.id;
 const indicators=[{name:'A',value:'1',status:'正常',reviewStatus:'已确认',dimension:'同化代谢'},{name:'B',value:'2',status:'异常',reviewStatus:'已确认',dimension:'防御与修护'},{name:'C',value:'3',status:'待确认',reviewStatus:'已确认',dimension:'能量生成'}];
 const suggestions=[{id:'suggestion-test',title:'test',content:'test',type:'饮食',category:'可选建议',module:'饮食回避',sourceModuleId:'diet-avoidance',reviewStatus:'待审核'}];
 await api(path+'/indicators','PUT',{indicators});
 const ed=(await api(path+'/evidence','POST',{})).data;ed.evidence.forEach(x=>x.reviewStatus='已确认');await api(path+'/evidence','PUT',{evidence:ed.evidence});
 await api(path+'/suggestions','PUT',{suggestions:[{...suggestions[0],reviewStatus:'已确认'}]});
 let plan=JSON.parse(await readFile(join(dir,project.id,'approved-plan.json'),'utf8'));
 assert.equal(plan.status,'已确认');
 assert.equal(plan.suggestions[0].reviewStatus,'已确认');
 assert.equal((await api(path+'/ppt-template')).data.ready,true);
 await api(path+'/suggestions','PUT',{suggestions});
 plan=JSON.parse(await readFile(join(dir,project.id,'approved-plan.json'),'utf8'));
 assert.equal(plan.status,'待审核');
 assert.equal(plan.suggestions[0].reviewStatus,'待审核');
 assert.equal((await api(path+'/ppt-template')).data.ready,false);
 for(const route of ['/synthesis','/matrix']){
  const dims=(await api(path+route)).data.dimensions;
  for(const [name,status] of [['同化代谢','未见明显异常'],['防御与修护','需关注'],['能量生成','待补充判断'],['压力','无相关数据']])assert.equal(dims.find(x=>x.name===name).assessmentStatus,status);
 }
 async function confirm(){const d=(await api(path+'/synthesis')).data;assert.equal((await api(path+'/synthesis','PUT',{status:'已确认',dataVersion:d.dataVersion})).status,200);return d.dataVersion;}
 for(const [route,body] of [['/indicators',{indicators:indicators.map(x=>({...x,value:x.value+'0'}))}],['/case',{caseData:{patient:{name:'changed'}}}],['/suggestions',{suggestions,reviewPeriod:'changed'}]]){
  const old=await confirm();await api(path+route,'PUT',body);
  assert.equal((await api(path+'/synthesis')).data.reviewStatus,'待审核');
  assert.equal(JSON.parse(await readFile(join(dir,project.id,'project.json'),'utf8')).synthesisReview.status,'待审核');
  assert.equal((await api(path+'/synthesis','PUT',{status:'已确认',dataVersion:old})).status,409);
  assert.equal((await api(path+'/export-ppt','POST',{})).status,400);
  if(route!=='/suggestions'){
   await api(path+'/suggestions','PUT',{suggestions:[{...suggestions[0],reviewStatus:'已确认'}]});
   assert.equal((await api(path+'/ppt-template')).data.ready,true);
  }
 }
 assert.equal((await api(path+'/ppt-template')).data.ready,false);
 await api(path+'/suggestions','POST',{});assert.equal((await api(path+'/synthesis')).data.reviewStatus,'待审核');
 const html=await readFile('index.html','utf8');const appSource=await readFile('app.js','utf8');assert.equal(html.split('id="generate-deepseek-suggestions"').length-1,1);assert.ok(html.includes('id="generate-suggestions-page"'));assert.ok(html.includes('data-step="6"'));assert.ok(appSource.includes('id="page-save-all"'));assert.ok(appSource.includes('saveSuggestions(true,true)'));assert.ok(!appSource.includes('[data-suggestion-check]'));
 console.log('PASS: case/indicator/advice invalidation; stale confirmation and export blocked; all four dimension states; unique buttons');
} finally {child.kill();await new Promise(resolve=>child.once('exit',resolve));await rm(dir,{recursive:true,force:true});}
