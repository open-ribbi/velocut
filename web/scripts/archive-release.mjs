import {readFile,writeFile,cp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyReleaseArtifacts} from './release-artifacts.mjs';

// Maintainer packaging on macOS/Linux; CI's archive job runs on Ubuntu.
// Consumers of either archive need Node/browser only, never tar/zip build tools.
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),root=resolve(repo,'artifacts');
const manifest=await verifyReleaseArtifacts(root);
const folder=`velocut-${manifest.version}`;
const plugin=JSON.parse(await readFile(resolve(root,folder,'plugins/velocut/.codex-plugin/plugin.json'),'utf8'));
if(plugin.version!==manifest.version)throw Error('Portable plugin version differs from the release');
await cp(resolve(repo,`docs/releases/v${manifest.version}.md`),resolve(root,'release-notes.md'));
const archives=['velocut-standalone.tar.gz','velocut-standalone.zip'];
for(const name of archives)await rm(resolve(root,name),{force:true});
execFileSync('tar',['-czf',archives[0],folder],{cwd:root,env:{...process.env,COPYFILE_DISABLE:'1'}});
execFileSync('zip',['-q','-X','-r',archives[1],folder],{cwd:root});
const files=[...manifest.packages.map(p=>p.file),...archives,'manifest.json','distribution-verification.json','release-notes.md'];
const sums=[];for(const file of files)sums.push(createHash('sha256').update(await readFile(resolve(root,file))).digest('hex')+'  '+file);
await writeFile(resolve(root,'SHA256SUMS.txt'),sums.join('\n')+'\n');
await writeFile(resolve(root,'release-files.txt'),[...files,'SHA256SUMS.txt'].join('\n')+'\n');
console.log(`Prepared ${manifest.version}: ${manifest.packages.length} npm packages, ZIP, TAR.GZ, release notes and SHA-256 checksums.`);
