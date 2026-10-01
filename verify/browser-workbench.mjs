/** Optional actual-React/Chromium verification; npm test remains dependency-free.
 * npm install --prefix node_modules/.scm-browser --no-audit --no-fund --package-lock=false react@19.2.0 react-dom@19.2.0 esbuild@0.25.10
 * node verify/browser-workbench.mjs
 * Requires the existing GUI on :3080, CHROME_BIN, and system Playwright.
 * API responses are isolated fixtures: never writes a live repository.
 */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const cache=join(root,'node_modules/.scm-browser');
const {build}=await import(join(cache,'node_modules/esbuild/lib/main.js'));
const {chromium}=await import('/usr/local/lib/node_modules/playwright/index.mjs');
await mkdir(cache,{recursive:true});
const entry=join(cache,'browser-entry.mjs'), bundle=join(cache,'browser-react.js');
await writeFile(entry,"import React from 'react';import{createRoot}from'react-dom/client';window.DscReact=React;window.DscCreateRoot=createRoot;");
await build({entryPoints:[entry],outfile:bundle,bundle:true,format:'iife'});
const source=join(root,'lib/client.js'),s=await stat(source),hash=createHash('sha1').update('plugin-artifact').update('\0');
for(const p of [String(s.mtimeMs),String(s.ctimeMs),String(s.size)])hash.update(`${Buffer.byteLength(p)}:`).update(p);
const revision=hash.digest('hex').slice(0,12);
const artifactURL=`http://127.0.0.1:3080/plugins/??dsh-source-control/client.js&rev=${revision}`;
const theme=`:root{--dsw-alias-label-primary:#d4d4d4;--dsw-alias-label-secondary:#929292;--dsw-alias-label-tertiary:#777;--dsw-alias-border-l1:#333;--dsw-alias-bg-layer-1:#252526;--dsw-alias-bg-layer-2:#2d2d30;--dsw-alias-interactive-bg-hover:#37373d;--dsw-alias-brand-primary:#007acc;--dsw-alias-state-success-primary:#89d185;--dsw-alias-state-error-primary:#f48771;--dsw-alias-state-warn-primary:#e2c08d;--dsw-alias-state-idle-primary:#cca700;--dsw-font-mono:Consolas,monospace}html,body{margin:0;height:100%;background:#1e1e1e;font-family:Arial,sans-serif}#mount{height:100%;display:flex;min-width:0;min-height:0}`;
const row=(path,extra={})=>({path,origPath:null,indexStatus:'.',worktreeStatus:'M',untracked:false,unmerged:false,...extra});
const hashes=Array.from({length:30},(_,i)=>(i+1).toString(16).padStart(40,'0'));
const status={repository:{root:'/repo',cwd:'/repo',branch:'feature/source-control',head:hashes[0],hasCommits:true},status:{ahead:2,behind:1,staged:[row('src/staged.ts',{indexStatus:'M',worktreeStatus:'.'})],changes:[row('src/modified.ts'),...Array.from({length:35},(_,i)=>row(`src/components/${i===3?'very-long-file-name-'.repeat(12):'component-'+i}.ts`))],untracked:[row('src/new.ts',{untracked:true,indexStatus:'?',worktreeStatus:'?'})],conflicted:[]}};
const branches={current:'feature/source-control',head:hashes[0],local:[{name:'feature/source-control',ref:'refs/heads/feature/source-control',hash:hashes[0],current:true,upstream:null,upstreamTarget:null},{name:'main',ref:'refs/heads/main',hash:hashes[5],current:false,upstream:'origin/main',upstreamTarget:{remote:'origin',branch:'main'}}],remote:[{name:'origin/main',ref:'refs/remotes/origin/main',hash:hashes[5],remote:'origin',branch:'main'}],remotes:[{name:'origin'}]};
const graph={hasMore:false,commits:hashes.map((hash,i)=>({hash,short:hash.slice(-7),parents:i===0?[hashes[1],hashes[3]]:i===3?[hashes[5]]:i<29?[hashes[i+1]]:[],subject:i===0?'Improve source control layout':`Commit ${i}`,author:'developer',date:'2026-09-30T12:00:00Z',refs:i===0?[{name:'feature/source-control',kind:'local'},{name:'HEAD',kind:'head'}]:i===5?[{name:'main',kind:'local'},{name:'origin/main',kind:'remote'}]:[]}))};
const details={commit:{...graph.commits[0],message:'Improve source control layout\n\nKeep worktree and historical views separate.'},files:[{path:'src/modified.ts',status:'M',oldPath:null},{path:'src/deleted.ts',status:'D',oldPath:null}]};
const diff={binary:false,added:2,removed:2,hunks:[1,18].map(n=>({header:`@@ -${n},3 +${n},3 @@`,oldStart:n,newStart:n,oldCount:3,newCount:3,lines:[{kind:'context',text:'const context = true;'},{kind:'del',text:'const previous = 1;'},{kind:'add',text:'const updated = 2;'},{kind:'context',text:'// long code line '+'.'.repeat(260)}]}))};
const git={available:true,repositories:[{root:'/repo',label:'repo',isRepository:true},{root:'/other',label:'other',isRepository:true}]};
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN,args:['--no-sandbox']});
let statusGate=null,releaseStatus=null,writeGate=null,releaseWrite=null;
const errors=[],requests=[];
try{
 const page=await browser.newPage({viewport:{width:1100,height:720}});
 page.setDefaultTimeout(12000);
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/source-control/**',async route=>{
  const req=route.request(),op=new URL(req.url()).pathname.split('/').pop(),body=req.postDataJSON();requests.push({op,body,url:req.url()});
  if(op==='status'&&statusGate)await statusGate;
  if(op==='stage'&&writeGate)await writeGate;
  const value=({git,status,branches,graph,'commit-details':details,'commit-diff':diff,diff,commit:{short:'newcommit'}})[op]??{};
  await route.fulfill({json:{ok:true,value}});
 });
 const live=await page.goto('http://127.0.0.1:3080/');console.log('Existing GUI shell',live.status(),'; isolated fixtures follow, no live API writes');
 await page.setContent(`<style>${theme}</style><div id="mount"></div>`);await page.addScriptTag({path:bundle});
 await page.evaluate(()=>window.__ModuleLoader__={load:r=>window.dscRegistration=r});
 const response=await page.request.get(artifactURL);assert.equal(response.status(),200);const expectedArtifact=(await readFile(source,'utf8'))+`;\n//# sourceMappingURL=??dsh-source-control/client.js.map&rev=${revision}\n`;
 const fingerprint=text=>createHash('sha256').update(text).digest('hex');
 assert.equal(fingerprint(await response.text()),fingerprint(expectedArtifact),'served artifact is current source plus the shell source-map trailer');
 await page.addScriptTag({url:artifactURL});
 await page.evaluate(()=>{
  const mod=window.dscRegistration.factory(n=>{if(n==='react')return window.DscReact;throw Error(n)}),slots=[];
  mod.apply({effect:fn=>fn(),locale:{register:()=>()=>{},bind:()=>key=>mod.messages.en[key]??key},sidebarRightTabs:{register:()=>()=>{}},sidebarRight:{},layout:{},slots:{inject:(n,fn)=>fn(),register:(options,component)=>{slots.push({options,component});return()=>{}}}});
  window.dscPage=slots.find(x=>x.options.name==='main').component;window.dscTab=slots.find(x=>x.options.name==='sidebar.right.pane.tab').component;
  window.dscRoot=window.DscCreateRoot(document.querySelector('#mount'));window.dscRoot.render(window.DscReact.createElement(window.dscPage));
 });
 const refresh=()=>page.locator('.dsc-navigator>.dsc-header').getByRole('button',{name:'Refresh',exact:true});
 await page.locator('.dsc-row[title="src/modified.ts"]').waitFor();await page.locator('.dsc-commitButton').first().waitFor();
 assert.equal(requests.filter(x=>['fetch','pull','push'].includes(x.op)).length,0,'rendering does not synchronize');
 const widthHandle=page.locator('.dsc-resize-width'),heightHandle=page.locator('.dsc-resize-height');
 const navWidth=async()=>page.locator('.dsc-navigator').evaluate(e=>e.getBoundingClientRect().width);
 const before=await navWidth();await widthHandle.focus();await widthHandle.press('ArrowRight');assert(await navWidth()>before,'width keyboard changes geometry');
 await widthHandle.dblclick();assert(Math.abs(await navWidth()-before)<2,'width reset restores default');
 let rect=await widthHandle.boundingBox();const work=await page.locator('.dsc-workbench').boundingBox();await page.mouse.move(rect.x+3,rect.y+30);await page.mouse.down();await page.mouse.move(work.x+work.width*.5,rect.y+30,{steps:8});await page.mouse.up();
 assert(Math.abs(Number(await widthHandle.getAttribute('aria-valuenow'))-50)<.2,'pointer width snaps to half');assert(await navWidth()>before+50,'width pointer changes actual width');await widthHandle.dblclick();
 const graphHeight=async()=>page.locator('.dsc-historySection').evaluate(e=>e.getBoundingClientRect().height);
 const originalGraph=await graphHeight();await heightHandle.focus();await heightHandle.press('ArrowUp');assert(await graphHeight()>originalGraph,'height keyboard changes geometry');
 rect=await heightHandle.boundingBox();const split=await page.locator('.dsc-split').boundingBox();await page.mouse.move(rect.x+30,rect.y+3);await page.mouse.down();await page.mouse.move(rect.x+30,split.y+split.height*.5,{steps:8});await page.mouse.up();
 assert(Math.abs(Number(await heightHandle.getAttribute('aria-valuenow'))-50)<.2,'height pointer snaps to half');await heightHandle.press('Home');assert.equal(await page.locator('.dsc-historyToggle').getAttribute('aria-expanded'),'false');await heightHandle.dblclick();assert(Math.abs(await graphHeight()-originalGraph)<2);
 console.log('Pointer, keyboard, snapping, collapse and reset PASS');
 await page.getByRole('searchbox').fill('modified');assert.equal(await page.locator('.dsc-row').count(),1);await page.getByRole('searchbox').fill('');
 await page.getByRole('button',{name:'Tree view',exact:true}).click();await page.locator('.dsc-folder').first().waitFor();await page.getByRole('button',{name:'List view',exact:true}).click();
 await page.locator('.dsc-commitButton').first().click();await page.locator('.dsc-details').waitFor();await page.locator('.dsc-details').getByRole('button',{name:/src\/modified.ts/}).click();await page.locator('.dsc-hunkHead').first().waitFor();assert.equal(await page.getByRole('button',{name:'Stage hunk',exact:true}).count(),0,'history is read-only');
 await page.locator('.dsc-row[title="src/modified.ts"]').click();await page.getByRole('button',{name:'Stage hunk',exact:true}).first().waitFor();
 for(const[width,height]of[[1100,720],[390,844],[390,640]]){
  await page.setViewportSize({width,height});
  const info=await page.evaluate(()=>{const rect=s=>{const b=document.querySelector(s)?.getBoundingClientRect();return b?{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}:null};return{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,nav:rect('.dsc-navigator'),list:rect('.dsc-body'),editor:rect('.dsc-editor'),history:rect('.dsc-historySection')}});
  console.log('Geometry',width,height,info);assert(info.width<=width&&info.height<=height+1,'no document overflow');assert(info.list.height>=50&&info.nav.width>0,'main list remains usable when diff open');assert(info.history.bottom<=info.nav.bottom+1,'graph remains within navigation');
  if(width>540)assert(info.editor.x>=info.nav.right-1);else assert(info.editor.y>=info.nav.bottom-1,'mobile stacks persistent navigator above editor');
  await page.screenshot({path:join(cache,`main-${width}-${height}.png`)});
 }
 await page.setViewportSize({width:1100,height:720});
 await page.locator('textarea').fill('repo draft');await page.locator('.dsc-pageHead select').selectOption('/other');await page.locator('.dsc-editorEmpty').waitFor();assert.equal(await page.locator('textarea').inputValue(),'');await page.locator('.dsc-pageHead select').selectOption('/repo');await page.locator('.dsc-editorEmpty').waitFor();
 await page.locator('.dsc-row[title="src/modified.ts"]').click();await page.getByRole('button',{name:'Stage hunk',exact:true}).first().waitFor();
 statusGate=new Promise(resolve=>releaseStatus=resolve);await page.getByRole('button',{name:'Stage hunk',exact:true}).first().click();await page.waitForFunction(()=>document.querySelectorAll('.dsc-hunkHead').length===0);releaseStatus();statusGate=null;await page.getByRole('button',{name:'Discard hunk',exact:true}).first().waitFor();
 await page.getByRole('button',{name:'Discard hunk',exact:true}).first().click();await page.getByRole('alertdialog').waitFor();statusGate=new Promise(resolve=>releaseStatus=resolve);await refresh().click();assert.equal(await page.getByRole('alertdialog').count(),0);assert.equal(requests.filter(x=>x.op==='discard-hunk').length,0);releaseStatus();statusGate=null;await page.getByRole('button',{name:'Stage hunk',exact:true}).first().waitFor();
 statusGate=new Promise(resolve=>releaseStatus=resolve);const releasePre=releaseStatus;await Promise.all([page.waitForRequest(r=>new URL(r.url()).pathname.endsWith('/status')),refresh().click()]);writeGate=new Promise(resolve=>releaseWrite=resolve);await Promise.all([page.waitForRequest(r=>new URL(r.url()).pathname.endsWith('/stage')),page.locator('.dsc-diffHead').getByRole('button',{name:'Stage',exact:true}).click()]);
 const preResponse=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/status'));releasePre();statusGate=null;await preResponse;assert.equal(await page.getByRole('button',{name:'Stage hunk',exact:true}).count(),0);statusGate=new Promise(resolve=>releaseStatus=resolve);const finalStatus=page.waitForRequest(r=>new URL(r.url()).pathname.endsWith('/status'));releaseWrite();writeGate=null;await finalStatus;assert.equal(await page.getByRole('button',{name:'Stage hunk',exact:true}).count(),0);releaseStatus();statusGate=null;await page.getByRole('button',{name:'Stage hunk',exact:true}).first().waitFor();
 console.log('Repository remount + stale hunk/overlapping refresh PASS');
 await page.locator('.dsc-header').getByRole('button',{name:'More Git actions',exact:true}).click();await page.getByRole('button',{name:'Fetch',exact:true}).click();const fetchDialog=page.getByRole('dialog',{name:'Fetch',exact:true});await fetchDialog.getByRole('button',{name:'Confirm',exact:true}).click();await fetchDialog.waitFor({state:'hidden'});assert.deepEqual(requests.find(x=>x.op==='fetch').body,{repo:'/repo',remote:'origin'});
 await page.locator('.dsc-header').getByRole('button',{name:'More Git actions',exact:true}).click();await page.getByRole('button',{name:'Push',exact:true}).click();const pushDialog=page.getByRole('dialog',{name:'Push',exact:true});await pushDialog.getByRole('button',{name:'Confirm',exact:true}).click();assert.equal(requests.filter(x=>x.op==='push').length,0,'first push needs separate upstream confirmation');await pushDialog.getByRole('button',{name:/upstream/i}).click();await pushDialog.waitFor({state:'hidden'});assert.equal(requests.find(x=>x.op==='push').body.sourceBranch,'feature/source-control');assert.equal(requests.find(x=>x.op==='push').body.setUpstream,true);
 console.log('Configured remote operation and explicit upstream payload PASS');
 await page.evaluate(()=>{window.dscRoot.unmount();window.dscRoot=window.DscCreateRoot(document.querySelector('#mount'));window.dscRoot.render(window.DscReact.createElement(window.dscTab,{sessionId:'session-1',useTabInfo:()=>null}));});await page.setViewportSize({width:320,height:620});await page.locator('.dsc-row[title="src/modified.ts"]').waitFor();await page.locator('.dsc-row[title="src/modified.ts"]').click();await page.getByRole('button',{name:'Discard hunk',exact:true}).first().waitFor();await page.getByRole('button',{name:'Discard hunk',exact:true}).first().click();
 const compact=await page.evaluate(()=>{const h=document.querySelector('.dsc-hunks').getBoundingClientRect(),c=document.querySelector('.dsc-confirm').getBoundingClientRect();return{hunkHeight:h.height,confirmBottom:c.bottom,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}});console.log('Compact geometry',compact);assert(compact.hunkHeight>40&&compact.confirmBottom<=621);assert(compact.width<=320&&compact.height<=621);await page.screenshot({path:join(cache,'tab-320-620.png')});
 assert.deepEqual(errors,[]);console.log('Actual React workbench checks PASS');
}finally{releaseStatus?.();releaseWrite?.();await browser.close();}
