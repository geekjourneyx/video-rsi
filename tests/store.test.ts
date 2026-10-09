import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const faults = vi.hoisted(() => ({renameTarget: ''}));
vi.mock('node:fs/promises', async importOriginal => {
 const fs = await importOriginal<typeof import('node:fs/promises')>();
 return {...fs, rename: async (from:Parameters<typeof fs.rename>[0], to:Parameters<typeof fs.rename>[1]) => {
  if (faults.renameTarget && String(to).endsWith(faults.renameTarget)) { faults.renameTarget=''; throw Object.assign(new Error('injected rename failure'), {code:'EIO'}); }
  return fs.rename(from,to);
 }};
});
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, rename } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { hashJson, loadCall, loadRun, lockRun, openRun, reopenRun, type RunStore } from '../src/store.js';
import type { Completion, CompletionRequest, RunManifest } from '../src/contracts.js';
import { brief, candidates, config } from './fixtures.js';
let root:string;
let stores:RunStore[];
const manifest = {schemaVersion:1,runId:'test-run',brief,config,prompts:{writer:'write',judge:'judge'},priceSnapshots:[],softwareVersion:'0.1.0',seed:1,operation:{kind:'create',review:true}} as RunManifest;
const request:CompletionRequest={callId:'writer-1',role:'writer',model:config.models.writer,system:'write',input:'input',maxOutputTokens:2048,timeoutMs:30000};
const response:Completion={text:'done',stopReason:'stop',usage:{inputTokens:10,outputTokens:20,estimatedCostMicrousd:30},raw:{apiKey:'secret',nested:{Authorization:'Bearer secret'},safe:true}};
async function open(){const store=await openRun(root,manifest);stores.push(store);return store;}
async function reopen(path:string){const store=await reopenRun(path);stores.push(store);return store;}
async function events(path:string){return (await readFile(join(path,'events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}
async function start(store:RunStore){await store.append({type:'call_started',payload:{callId:request.callId,request,reservationMicrousd:100}});}
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'video-rsi-store-'));stores=[];faults.renameTarget='';});
afterEach(async()=>{await Promise.all(stores.map(s=>s.close()));await rm(root,{recursive:true,force:true});});
describe('run evidence',()=>{
 it('atomically persists manifest and result and completes a contiguous ledger',async()=>{
  const s=await open();expect(s.path).toBe(join(root,manifest.runId));
  expect(JSON.parse(await readFile(join(s.path,'manifest.json'),'utf8'))).toEqual(manifest);
  await s.complete(candidates);const record=await loadRun(s.path);
  expect(record.result).toEqual(candidates);expect(record.status).toBe('completed');
  expect(record.events.map(e=>[e.seq,e.type])).toEqual([[1,'started'],[2,'completed']]);
  expect((await readdir(s.path)).some(name=>name.endsWith('.tmp'))).toBe(false);
 });
 it('rejects concurrent opens and refuses overwriting an existing run after close',async()=>{
  const s=await open();await expect(openRun(root,manifest)).rejects.toMatchObject({code:5});await s.close();
  await expect(openRun(root,manifest)).rejects.toMatchObject({code:5});
 });
 it('serializes concurrent appends with contiguous sequence numbers',async()=>{
  const s=await open();await Promise.all(Array.from({length:10},(_,i)=>s.append({type:'round_finished',payload:{round:i}})));
  expect((await loadRun(s.path)).events.map(e=>e.seq)).toEqual(Array.from({length:11},(_,i)=>i+1));
 });
 it('never recovers a live or foreign-host lock',async()=>{
  await writeFile(join(root,'lock'),JSON.stringify({pid:process.pid,hostname:hostname(),token:'live'}));
  await expect(lockRun(root,true)).rejects.toMatchObject({code:5});
  await writeFile(join(root,'lock'),JSON.stringify({pid:2147483647,hostname:'foreign.invalid',token:'foreign'}));
  await expect(lockRun(root,true)).rejects.toMatchObject({code:5});
 });
 it('recovers a dead PID only explicitly and one recovery owns the lock',async()=>{
  await writeFile(join(root,'lock'),JSON.stringify({pid:2147483647,hostname:hostname(),token:'dead'}));
  await expect(lockRun(root,false)).rejects.toMatchObject({code:5});
  const attempts=await Promise.allSettled([lockRun(root,true),lockRun(root,true)]);
  expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
  for(const a of attempts)if(a.status==='fulfilled')await a.value();
 });
 it('ignores an unterminated tail for reading and truncates it only under reopen lock',async()=>{
  const s=await open();await s.close();const log=join(s.path,'events.jsonl');const original=await readFile(log,'utf8');
  await writeFile(log,original+'{"seq":2');expect((await loadRun(s.path)).events).toHaveLength(1);
  expect(await readFile(log,'utf8')).toBe(original+'{"seq":2');await (await reopen(s.path)).close();
  expect(await readFile(log,'utf8')).toBe(original);
 });
 it.each(['{broken}\n',JSON.stringify({schemaVersion:1,runId:'test-run',seq:3,type:'round_finished',at:new Date().toISOString(),payload:{}})+'\n'])('rejects malformed middle JSON or noncontiguous seq',async(bad)=>{
  const s=await open();await s.close();const log=join(s.path,'events.jsonl');await writeFile(log,(await readFile(log,'utf8'))+bad);
  await expect(loadRun(s.path)).rejects.toMatchObject({code:5});
 });
 it('marks a started call without durable response unknown without fabricating success',async()=>{
  const s=await open();await start(s);await s.close();const resumed=await reopen(s.path);
  expect((await loadRun(s.path)).events.map(e=>e.type)).toEqual(['started','call_started','call_unknown']);
  expect(await loadCall(s.path,request.callId)).toBeUndefined();await resumed.close();
  await (await reopen(s.path)).close();expect((await events(s.path)).filter(e=>e.type==='call_unknown')).toHaveLength(1);
 });
 it('recovers an atomically saved response missing call_finished using its hash',async()=>{
  const s=await open();await start(s);await s.saveCall(request.callId,request,response);await s.close();await (await reopen(s.path)).close();
  const call=await loadCall(s.path,request.callId);expect(call?.result.text).toBe('done');
  const record=await loadRun(s.path);expect(record.events.map(e=>e.type)).toEqual(['started','call_started','call_finished']);
  expect(record.events[2].payload).toMatchObject({callId:request.callId,hash:call?.hash,recovered:true});
  const disk=await readFile(join(s.path,'calls',request.callId+'.json'),'utf8');expect(disk).not.toContain('secret');expect(disk).not.toContain('Authorization');
 });
 it('repairs completed after durable result survives but final log append fails',async()=>{
  const s=await open();const log=join(s.path,'events.jsonl');await rename(log,log+'.backup');await mkdir(log);
  await expect(s.complete(candidates)).rejects.toMatchObject({code:5});
  expect(JSON.parse(await readFile(join(s.path,'result.json'),'utf8')).result).toEqual(candidates);
  await rm(log,{recursive:true});await rename(log+'.backup',log);await s.close();await (await reopen(s.path)).close();
  const record=await loadRun(s.path);expect(record.status).toBe('completed');expect(record.result).toEqual(candidates);
  expect(record.events[1].payload).toMatchObject({recovered:true});
 });
 it('rejects modified result or response hashes and finished calls missing files',async()=>{
  const s=await open();await start(s);await s.saveCall(request.callId,request,response);await s.append({type:'call_finished',payload:{callId:request.callId}});await s.complete(candidates);await s.close();
  const file=join(s.path,'result.json'),original=await readFile(file,'utf8');const value=JSON.parse(original);value.result.candidates[0].title='tampered';await writeFile(file,JSON.stringify(value));
  await expect(loadRun(s.path)).rejects.toMatchObject({code:5});await writeFile(file,original);
  const callFile=join(s.path,'calls',request.callId+'.json'),callOriginal=await readFile(callFile,'utf8');const call=JSON.parse(callOriginal);call.result.text='tampered';await writeFile(callFile,JSON.stringify(call));
  await expect(loadRun(s.path)).rejects.toMatchObject({code:5});await rm(callFile);
  await expect(loadRun(s.path)).rejects.toMatchObject({code:5});
 });
 it('rejects unsafe call IDs, duplicate paid attempts, and mismatched requests',async()=>{
  const s=await open();await expect(s.saveCall('../escape',request,response)).rejects.toMatchObject({code:5});await start(s);
  await expect(start(s)).rejects.toMatchObject({code:5});
  await expect(s.saveCall(request.callId,{...request,input:'changed'},response)).rejects.toMatchObject({code:5});
  await s.saveCall(request.callId,request,response);await expect(s.saveCall(request.callId,request,{...response,text:'overwrite'})).rejects.toMatchObject({code:5});
 });
 it('requires explicit operation and preserves exact standalone judge input and hash',async()=>{
  await expect(openRun(root,{...manifest,operation:undefined} as unknown as RunManifest)).rejects.toMatchObject({code:5});
  const judge={...manifest,operation:{kind:'judge'},inputBatch:candidates,inputBatchHash:hashJson(candidates)} as RunManifest;
  const s=await openRun(root,judge);stores.push(s);expect((await loadRun(s.path)).manifest).toEqual(judge);
  await s.close();await expect(openRun(root,{...judge,runId:'other',inputBatchHash:'wrong'})).rejects.toMatchObject({code:5});
 });
 it('rejects write after close and incomplete paid calls at completion',async()=>{
  const s=await open();await start(s);await expect(s.complete(candidates)).rejects.toMatchObject({code:5});await s.close();
  await expect(s.append({type:'stopped',payload:{}})).rejects.toMatchObject({code:5});
 });
 it('removes temporary files when atomic response commit fails',async()=>{
  const s=await open();await start(s);await mkdir(join(s.path,'calls',request.callId+'.json'));
  await expect(s.saveCall(request.callId,request,response)).rejects.toMatchObject({code:5});
  expect((await readdir(join(s.path,'calls'))).filter(n=>n.endsWith('.tmp'))).toEqual([]);
 });
 it('detects corruption in manifest inputs and prompt snapshots',async()=>{
  const s=await open();await s.close();const file=join(s.path,'manifest.json');const value=JSON.parse(await readFile(file,'utf8'));value.prompts.writer='changed';await writeFile(file,JSON.stringify(value));
  await expect(loadRun(s.path)).rejects.toMatchObject({code:5});
 });
 it('cleans an atomic temporary file on injected rename failure and records no finished response',async()=>{
  const s=await open();await start(s);faults.renameTarget=request.callId+'.json';
  await expect(s.saveCall(request.callId,request,response)).rejects.toMatchObject({code:5});
  expect(await readdir(join(s.path,'calls'))).toEqual([]);await s.close();await (await reopen(s.path)).close();
  expect((await loadRun(s.path)).events.map(e=>e.type)).toEqual(['started','call_started','call_unknown']);
 });
 it('preserves unknown attempts and permits completion only after an explicit successful retry lineage',async()=>{
  const s=await open();await start(s);await s.close();const resumed=await reopen(s.path);
  const retry={...request,callId:'writer-1-retry'};
  await resumed.append({type:'call_started',payload:{callId:retry.callId,request:retry,retryOf:request.callId,reservationMicrousd:100}});
  await resumed.saveCall(retry.callId,retry,response);await resumed.append({type:'call_finished',payload:{callId:retry.callId}});await resumed.complete(candidates);
  const record=await loadRun(s.path);expect(record.status).toBe('completed');expect(record.events.filter(e=>e.type==='call_started')).toHaveLength(2);expect(record.events.filter(e=>e.type==='call_unknown')).toHaveLength(1);
 });
 it('rejects retry references to active attempts and duplicate retry children',async()=>{
  const s=await open();await start(s);
  await expect(s.append({type:'call_started',payload:{callId:'retry',retryOf:request.callId}})).rejects.toMatchObject({code:5});
  await s.append({type:'call_unknown',payload:{callId:request.callId}});await s.append({type:'call_started',payload:{callId:'retry',retryOf:request.callId}});
  await expect(s.append({type:'call_started',payload:{callId:'retry2',retryOf:request.callId}})).rejects.toMatchObject({code:5});
 });

 it('preserves exact whitespace in started and saved request snapshots',async()=>{
  const s=await open();const exact={...request,system:'  write\n\n',input:'\n input \t\n'};
  await s.append({type:'call_started',payload:{callId:exact.callId,request:exact,reservationMicrousd:100}});
  await s.saveCall(exact.callId,exact,response);await s.close();await (await reopen(s.path)).close();
  expect((await loadCall(s.path,exact.callId))?.request).toEqual(exact);
  expect((await loadRun(s.path)).events[1].payload).toMatchObject({request:exact});
 });
 it('finishes and repairs durable responses above the former aggregate journal cap',async()=>{
  const s=await open();const padding='x'.repeat(600_000);
  await s.append({type:'round_finished',payload:{padding}});await s.append({type:'round_finished',payload:{padding}});
  await start(s);await s.saveCall(request.callId,request,response);await s.close();
  expect(Buffer.byteLength(await readFile(join(s.path,'events.jsonl'),'utf8'))).toBeGreaterThan(1_048_576);
  const resumed=await reopen(s.path);await resumed.complete(candidates);
  const record=await loadRun(s.path);expect(record.status).toBe('completed');
  expect(record.events.find(e=>e.type==='call_finished')?.payload).toMatchObject({callId:request.callId,recovered:true});
 });
 it('bounds individual journal records without bounding the entire journal',async()=>{
  const s=await open();await expect(s.append({type:'round_finished',payload:{padding:'x'.repeat(8_388_608)}})).rejects.toMatchObject({code:5});
  await s.complete(candidates);expect((await loadRun(s.path)).status).toBe('completed');
 });
 it('recovers a locally dead recovery guard but rejects live and foreign guard ownership',async()=>{
  const guard=join(root,'lock.recovery');await mkdir(guard);
  await writeFile(join(root,'lock'),JSON.stringify({pid:2147483647,hostname:hostname(),token:'dead-lock'}));
  const file=join(guard,'owner-old.json');await writeFile(file,JSON.stringify({pid:process.pid,hostname:hostname(),token:'old'}));
  await expect(lockRun(root,true)).rejects.toMatchObject({code:5});
  await writeFile(file,JSON.stringify({pid:2147483647,hostname:'foreign.invalid',token:'old'}));
  await expect(lockRun(root,true)).rejects.toMatchObject({code:5});
  await writeFile(file,JSON.stringify({pid:2147483647,hostname:hostname(),token:'old'}));
  const attempts=await Promise.allSettled([lockRun(root,true),lockRun(root,true)]);
  expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
  for(const attempt of attempts)if(attempt.status==='fulfilled')await attempt.value();
  expect(await readdir(root)).not.toContain('lock.recovery');
 });
 it('recovers after a real process is SIGKILLed while owning the recovery guard',async()=>{
  const modules=join(root,'modules');await mkdir(modules);await writeFile(join(modules,'package.json'),JSON.stringify({type:'module'}));
  for(const name of ['store','contracts','errors']) {
   const source=await readFile(join(process.cwd(),'src',name+'.ts'),'utf8');
   const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
   await writeFile(join(modules,name+'.js'),output.replace("from 'zod'",'from '+JSON.stringify(pathToFileURL(join(process.cwd(),'node_modules/zod/index.js')).href)));
  }
  await writeFile(join(root,'lock'),JSON.stringify({pid:2147483647,hostname:hostname(),token:'dead-lock'}));
  const entry=join(modules,'interrupt.js');await writeFile(entry,`
   import {lockRun} from './store.js';
   const realKill=process.kill.bind(process);
   process.kill=(pid,signal)=>{
    if(pid===2147483647 && signal===0){process.send({ready:true});realKill(process.pid,'SIGSTOP');throw Object.assign(new Error('dead'),{code:'ESRCH'});}
    return realKill(pid,signal);
   };
   await lockRun(process.argv[2],true);
  `);
  const child=fork(entry,[root],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr?.on('data',data=>{stderr+=String(data);});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  try {
   await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Child did not reach interruption point: '+stderr)),5000);
    child.once('message',()=>{clearTimeout(timeout);resolve();});child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Child exited before guard acquisition: '+stderr));});
   });
   child.kill('SIGKILL');await exited;
   const release=await lockRun(root,true);try{await expect(lockRun(root,true)).rejects.toMatchObject({code:5});}finally{await release();}
   expect(await readdir(root)).not.toContain('lock.recovery');
  } finally {child.kill('SIGKILL');await exited;}
 });

 it('saves a near-1 MiB valid request plus response envelope exceeding the public input cap',async()=>{
  const s=await open();const nearLimit={...request,input:'x'.repeat(1_048_000)};
  await s.append({type:'call_started',payload:{callId:nearLimit.callId,request:nearLimit}});
  await s.saveCall(nearLimit.callId,nearLimit,{...response,text:'y'.repeat(40_000)});await s.close();await (await reopen(s.path)).close();
  expect((await loadCall(s.path,nearLimit.callId))?.request.input).toHaveLength(1_048_000);
  expect(Buffer.byteLength(await readFile(join(s.path,'calls',nearLimit.callId+'.json'),'utf8'))).toBeGreaterThan(1_048_576);
 });

 it('preserves exact manifest prompt snapshot bytes for resumed requests',async()=>{
  const exact={...manifest,prompts:{writer:' write\n\n',judge:' judge \n'}};
  const s=await openRun(root,exact);stores.push(s);expect((await loadRun(s.path)).manifest.prompts).toEqual(exact.prompts);
 });

});
