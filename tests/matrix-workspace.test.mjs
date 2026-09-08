import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir=await mkdtemp(join(tmpdir(),"matrix-workspace-"));
const child=spawn(process.execPath,["server.mjs"],{env:{...process.env,PORT:"4191",DATA_ROOT:dir},stdio:["ignore","pipe","inherit"]});
try {
 await new Promise((resolve,reject)=>{child.stdout.once("data",resolve);child.once("error",reject)});
 const api=async(path,method="GET",body)=>{const r=await fetch("http://localhost:4191"+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
 const project=(await api("/api/projects","POST",{name:"矩阵测试"})).data;const base=`/api/projects/${project.id}`;
 let d=await api(base+"/matrix-workspace");assert.equal(d.status,200);assert.equal(d.data.workspace.sections.length,9);assert.equal(d.data.workspace.status,"待审核");
 const section={...d.data.workspace.sections[0],reviewStatus:"已确认",interpretation:"人工核对后的故事摘要",questions:d.data.workspace.sections[0].questions.map((q,i)=>i===0?{...q,answer:"反复鼻部症状",sourceType:"manual"}:q)};
 d=await api(base+"/matrix-workspace/sections/story","PUT",{section});assert.equal(d.status,200);assert.equal(d.data.workspace.sections[0].reviewStatus,"已确认");assert.equal(d.data.workspace.status,"待审核");
 d=await api(base+"/matrix-workspace/export");assert.equal(d.status,200);assert.equal(d.data.workspace.sections[0].questions[0].answer,"反复鼻部症状");
 console.log("PASS: matrix workspace initialization; section review/save; independent export");
} finally {child.kill();await new Promise(resolve=>child.once("exit",resolve));await rm(dir,{recursive:true,force:true})}
