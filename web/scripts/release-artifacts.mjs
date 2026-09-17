import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,basename} from 'node:path';

/** Validate the entire release before the first registry write or archive operation. */
export async function verifyReleaseArtifacts(root,{sourceRoot=resolve(root,'..')}={}){
  const manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
  const verified=JSON.parse(await readFile(resolve(root,'distribution-verification.json'),'utf8'));
  if(!verified.ok)throw Error('Distribution verification is required');
  if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version))throw Error('Invalid release version');
  if(!Array.isArray(manifest.packages)||!manifest.packages.length)throw Error('No release packages');
  const names=new Set(manifest.packages.map(p=>p.name));
  if(names.size!==manifest.packages.length||verified.packages.length!==names.size)throw Error('Release package sets do not match');
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim();
  if(manifest.sourceCommit!==head)throw Error('Release artifacts are from another commit; rebuild and verify HEAD');
  if(execFileSync('git',['status','--porcelain'],{cwd:sourceRoot,encoding:'utf8'}).trim())throw Error('Commit release changes before publishing or archiving');
  const ready=new Set();
  for(const pkg of manifest.packages){
    if(!pkg.dependencies||typeof pkg.dependencies!=='object'||Array.isArray(pkg.dependencies))throw Error(`Missing dependency metadata: ${pkg.name}`);
    for(const [dependency,version] of Object.entries(pkg.dependencies))if(version!==manifest.version||!ready.has(dependency))throw Error(`Invalid publish order or dependency version: ${pkg.name} needs ${dependency}@${version}`);
    if(pkg.version!==manifest.version||typeof pkg.file!=='string'||basename(pkg.file)!==pkg.file||!pkg.file.endsWith('.tgz'))throw Error(`Invalid release package: ${pkg.name}`);
    const hash=createHash('sha256').update(await readFile(resolve(root,pkg.file))).digest('hex');
    if(hash!==pkg.sha256||!verified.packages.some(v=>v.name===pkg.name&&v.sha256===hash))throw Error(`Artifact ${pkg.name} differs from its tested bytes`);
    ready.add(pkg.name);
  }
  return manifest;
}
