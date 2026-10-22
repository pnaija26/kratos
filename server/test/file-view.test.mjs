import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const dataDir=mkdtempSync(join(tmpdir(),'kratos-file-view-'));
process.env.DATA_DIR=dataDir;
const {createSession,getDb}=await import('../dist/db.js');
const {filesRouter}=await import('../dist/api/files.js');
const {default:express}=await import('express');

const ws=join(dataDir,'ws');mkdirSync(join(ws,'sub'),{recursive:true});
writeFileSync(join(ws,'notes.txt'),'line one\nline two\n');
writeFileSync(join(ws,'page.html'),'<script>alert(1)</script>');
writeFileSync(join(ws,'sub','pic.png'),Buffer.from([0x89,0x50,0x4e,0x47]));
writeFileSync(join(ws,'doc.pdf'),'%PDF-1.4');
writeFileSync(join(dataDir,'secret.txt'),'outside');
createSession({id:'s1',title:'t',workspace:ws,executor:'pi'});

const app=express();app.use('/api',filesRouter());
const server=app.listen(0);const base=`http://127.0.0.1:${server.address().port}/api/sessions/s1/file?path=`;
test.after(()=>{server.close();getDb().close();rmSync(dataDir,{recursive:true,force:true});});

test('text is served as sandboxed plain text, HTML included',async()=>{
 let r=await fetch(base+'notes.txt');assert.equal(r.status,200);
 assert.match(r.headers.get('content-type'),/^text\/plain/);assert.match(r.headers.get('content-security-policy'),/sandbox/);
 assert.equal(await r.text(),'line one\nline two\n');
 r=await fetch(base+'page.html');assert.match(r.headers.get('content-type'),/^text\/plain/);
});

test('a range request reads only the head',async()=>{
 const r=await fetch(base+'notes.txt',{headers:{Range:'bytes=0-3'}});
 assert.equal(r.status,206);assert.equal(await r.text(),'line');
});

test('media keeps its type; PDFs skip the sandbox; download is an attachment',async()=>{
 let r=await fetch(base+'sub%2Fpic.png');assert.equal(r.headers.get('content-type'),'image/png');
 r=await fetch(base+'doc.pdf');assert.equal(r.headers.get('content-type'),'application/pdf');
 assert.equal(r.headers.get('content-security-policy'),null);
 r=await fetch(base+'notes.txt&download=1');assert.equal(r.headers.get('content-type'),'application/octet-stream');
 assert.match(r.headers.get('content-disposition'),/^attachment/);
});

test('nothing outside the workspace, and no folders',async()=>{
 assert.equal((await fetch(base+'..%2Fsecret.txt')).status,400);
 assert.equal((await fetch(base+'sub')).status,404);
 assert.equal((await fetch(base+'missing.txt')).status,404);
 assert.equal((await fetch(base)).status,400);
});

test('symlinks are refused, to files and through folders',async(t)=>{
 // Junctions need no privilege on Windows; file symlinks do, so either may be all we get.
 let made=0;
 try{symlinkSync(dataDir,join(ws,'out'),'junction');made++;
  assert.equal((await fetch(base+'out%2Fsecret.txt')).status,404);}catch(e){if(e.code===undefined)throw e;}
 try{symlinkSync(join(dataDir,'secret.txt'),join(ws,'link.txt'));made++;
  assert.equal((await fetch(base+'link.txt')).status,404);}catch(e){if(e.code===undefined)throw e;}
 if(!made)t.skip('cannot create symlinks here');
});
