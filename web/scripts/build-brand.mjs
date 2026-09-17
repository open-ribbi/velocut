/** The SVG is the source of truth. Export the PNG sizes required by plugin install surfaces. */
import {chromium} from '@playwright/test';
import {readFile,cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const assets=new URL('../../plugins/velocut/assets/',import.meta.url);
const svg=await readFile(new URL('logo.svg',assets),'utf8');
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({deviceScaleFactor:1});
  for(const [name,size] of [['logo.png',512],['icon.png',64]]){
    await page.setViewportSize({width:size,height:size});
    await page.setContent(`<body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`);
    await page.locator('img').evaluate(image=>image.decode());
    await page.screenshot({path:fileURLToPath(new URL(name,assets)),omitBackground:true});
  }
} finally {await browser.close();}
for(const name of ['editor.png','director.png'])await cp(new URL('../../docs/media/'+name,import.meta.url),new URL(name,assets));
console.log('Exported plugin logos and copied product screenshots.');
