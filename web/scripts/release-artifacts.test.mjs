import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyReleaseArtifacts} from './release-artifacts.mjs';

async function fixture(t){
 const sourceRoot=await mkdtemp(join(tmpdir(),'velocut-release-check-')),root=join(sourceRoot,'artifacts');
 t.after(()=>rm(sourceRoot,{recursive:true,force:true}));await mkdir(root);await writeFile(join(sourceRoot,'.gitignore'),'artifacts/\n');
 const git=args=>execFileSync('git',['-c','commit.gpgsign=false','-c',`core.hooksPath=${join(sourceRoot,'no-hooks')}`,...args],{cwd:sourceRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init','-q']);git(['add','.gitignore']);git(['-c','user.name=Release fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 const packages=[{name:'@velocut/cli',file:'cli.tgz',dependencies:{}},{name:'@velocut/mcp',file:'mcp.tgz',dependencies:{'@velocut/cli':'0.0.2'}}].map(p=>({...p,version:'0.0.2',sha256:createHash('sha256').update(p.name).digest('hex')}));
 const manifest={version:'0.0.2',sourceCommit:git(['rev-parse','HEAD']),packages};
 const restore=async(m=manifest)=>{await writeFile(join(root,'manifest.json'),JSON.stringify(m));await writeFile(join(root,'distribution-verification.json'),JSON.stringify({ok:true,packages:packages.map(({name,sha256})=>({name,sha256}))}));for(const p of packages)await writeFile(join(root,p.file),p.name);};
 await restore();return {root,sourceRoot,manifest,restore};
}
test('release preflight requires clean matching source and verified bytes for every package',async t=>{
 const f=await fixture(t);assert.equal((await verifyReleaseArtifacts(f.root)).version,'0.0.2');
 await writeFile(join(f.root,'mcp.tgz'),'changed later package');await assert.rejects(()=>verifyReleaseArtifacts(f.root),/differs from its tested bytes/);
 await f.restore({...f.manifest,sourceCommit:'stale'});await assert.rejects(()=>verifyReleaseArtifacts(f.root),/another commit/);
 await f.restore();await writeFile(join(f.sourceRoot,'uncommitted.txt'),'new change');await assert.rejects(()=>verifyReleaseArtifacts(f.root),/Commit release changes/);
});
test('release preflight rejects dependency order mistakes and incomplete verification records',async t=>{
 const f=await fixture(t);await f.restore({...f.manifest,packages:[...f.manifest.packages].reverse()});await assert.rejects(()=>verifyReleaseArtifacts(f.root),/publish order/);
 await f.restore();await writeFile(join(f.root,'distribution-verification.json'),JSON.stringify({ok:true,packages:[]}));await assert.rejects(()=>verifyReleaseArtifacts(f.root),/package sets/);
});
