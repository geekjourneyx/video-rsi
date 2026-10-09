import {it,expect} from 'vitest';
import {Readable,Writable} from 'node:stream';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {main} from '../src/cli.js';
import {readJson} from '../src/io.js';
function sink(){let text='';return {stream:new Writable({write(chunk,_encoding,done){text+=chunk;done();}}),text:()=>text};}
it('help needs no config or environment',async()=>{const out=sink(),err=sink();expect(await main(['--help'],{stdin:Readable.from([]),stdout:out.stream,stderr:err.stream})).toBe(0);expect(out.text()).toContain('video-rsi');expect(err.text()).toBe('');});
it('version works offline',async()=>{const out=sink(),err=sink();expect(await main(['--version'],{stdin:Readable.from([]),stdout:out.stream,stderr:err.stream})).toBe(0);expect(out.text()).toBe(JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version+'\n');});
it.each([['unknown'],['create','brief.json'],['--bad'],['--help','--bad']])('unsupported input %j returns 2',async(...argv)=>{const out=sink(),err=sink();expect(await main(argv as string[],{stdin:Readable.from([]),stdout:out.stream,stderr:err.stream})).toBe(2);expect(out.text()).toBe('');expect(JSON.parse(err.text()).code).toBe(2);});
it('reads stdin JSON',async()=>expect(await readJson('-',Readable.from(['{"ok":true}']))).toEqual({ok:true}));
it('rejects oversized stdin',async()=>expect(readJson('-',Readable.from([' '.repeat(1048577)]))).rejects.toThrow(/1 MiB/));
it('rejects oversized files',async()=>{const dir=await mkdtemp(join(tmpdir(),'video-rsi-'));try{const file=join(dir,'input');await writeFile(file,' '.repeat(1048577));await expect(readJson(file,Readable.from([]))).rejects.toThrow(/1 MiB/);}finally{await rm(dir,{recursive:true,force:true});}});
it('rejects invalid JSON with input error',async()=>{await expect(readJson('-',Readable.from(['bad']))).rejects.toMatchObject({code:2});});
