import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SuiteImportPreview, SuiteImportReceipt } from '../shared/suite-import';

test('imported evidence loads explicitly, renders source as text, and exports with fresh authority on mobile and desktop',async({page,context,request,baseURL})=>{
 const sourceKey=`browser-${randomUUID()}`,sourcePHID='PHID-BLOG-browser',xml=`<mysqldump><database name="phabricator_phame"><table_data name="phame_blog"><row><field name="id">1</field><field name="phid">${sourcePHID}</field><field name="name">Historical browser blog</field><field name="description">&lt;script&gt;window.importedScriptExecuted=true&lt;/script&gt;</field><field name="status">active</field></row></table_data></database></mysqldump>`;
 const input={sourceKey,files:[{name:'phame.xml',xml}],destination:{spaceId:'S1',visibility:'members',memberIds:[],editorIds:[]}};
 const previewResult=await request.post(new URL('api/suite-import/preview',baseURL!).href,{data:input});expect(previewResult.ok(),await previewResult.text()).toBe(true);const preview=await previewResult.json() as SuiteImportPreview;expect(preview.canApply).toBe(true);
 const result=await request.post(new URL('api/suite-import/apply',baseURL!).href,{headers:{'Idempotency-Key':randomUUID()},data:{request:input,previewDigest:preview.digest}});expect(result.ok(),await result.text()).toBe(true);const receipt=await result.json() as SuiteImportReceipt,id=receipt.records[0]!.recordId;
 let reads=0;page.on('request',value=>{if(value.url().includes(`/api/suite-import/provenance/${id}`))reads++;});
 await page.goto(`./#phame/${id}`);await expect(page.getByRole('button',{name:'Inspect Imported History',exact:true})).toBeVisible();expect(reads).toBe(0);
 await page.getByRole('button',{name:'Inspect Imported History',exact:true}).click();await expect(page.getByText('Historical, unverified source evidence.',{exact:false})).toBeVisible();await expect(page.getByText(`${sourceKey} · ${sourcePHID}`,{exact:true})).toBeVisible();
 await page.locator('summary').filter({hasText:'phame_blog · PHID-BLOG-browser'}).click();const imported=page.locator('section').filter({has:page.getByRole('heading',{name:'Imported History',exact:true})}),source=imported.locator('pre').filter({hasText:'importedScriptExecuted'});await expect(source).toBeVisible();expect(await page.evaluate(()=>Reflect.get(window,'importedScriptExecuted'))).toBeUndefined();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 let intercepted!:()=>void,releaseHeld!:()=>void,delivered!:()=>void,downloads=0;
 page.on('download',()=>downloads++);
 const exportStarted=new Promise<void>(resolve=>{intercepted=resolve;}),release=new Promise<void>(resolve=>{releaseHeld=resolve;}),exportDelivered=new Promise<void>(resolve=>{delivered=resolve;});let hold=true;
 await page.route(`**/api/suite-import/provenance/${id}`,async route=>{if(!hold){await route.continue();return;}hold=false;const response=await route.fetch();intercepted();await release;await route.fulfill({response});delivered();});
 await page.getByRole('button',{name:'Export Imported History',exact:true}).click();await exportStarted;await context.setOffline(true);
 await expect(page.getByText('You are offline. Keep drafts open or export them. Reconnecting never submits changes automatically.',{exact:true})).toBeVisible();await expect(imported).toHaveCount(0);
 releaseHeld();await exportDelivered;await context.setOffline(false);
 await expect(page.getByRole('button',{name:'Inspect Imported History',exact:true})).toBeVisible();await page.getByRole('button',{name:'Inspect Imported History',exact:true}).click();await expect(page.getByText(`${sourceKey} · ${sourcePHID}`,{exact:true})).toBeVisible();expect(downloads).toBe(0);
 await expect(page.getByRole('button',{name:'Export Imported History',exact:true})).toBeEnabled();
 const before=reads,download=page.waitForEvent('download');await page.getByRole('button',{name:'Export Imported History',exact:true}).click();const saved=await download;expect(reads).toBeGreaterThan(before);const data=JSON.parse(await readFile((await saved.path())!,'utf8'));expect(data.sourcePHID).toBe(sourcePHID);expect(data.assertionStatus).toBe('historical-unverified');
 await page.getByRole('button',{name:'Close',exact:true}).click();await expect(page.getByRole('button',{name:'Inspect Imported History',exact:true})).toBeVisible();await expect(source).toHaveCount(0);
});
