/** Export display sizes from the generated mascot master without changing its artwork. */
import {chromium} from '@playwright/test';
import {readFile,cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const assets=new URL('../../plugins/velocut/assets/',import.meta.url);
const master=await readFile(new URL('../../docs/brand/mascot-source.png',import.meta.url));
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({deviceScaleFactor:1});
  for(const [name,size] of [['logo-mascot.png',512],['icon-mascot.png',64]]){
    await page.setViewportSize({width:size,height:size});
    await page.setContent(`<body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/png;base64,${master.toString('base64')}">`);
    await page.locator('img').evaluate(image=>image.decode());
    await page.screenshot({path:fileURLToPath(new URL(name,assets)),omitBackground:true});
  }
} finally {await browser.close();}
for(const name of ['editor.png','director.png'])await cp(new URL('../../docs/media/'+name,import.meta.url),new URL(name,assets));
console.log('Exported plugin logos and copied product screenshots.');
