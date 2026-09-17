import {test as base} from '@playwright/test';
export {expect} from '@playwright/test';
export type * from '@playwright/test';

/** Every browser test starts without personal model connections or service credentials.
 * Tests of model administration install their own page route to an isolated temporary host. */
export const test=base.extend<{isolatedModels:void}>({
  isolatedModels:[async({context},use)=>{
    await context.route('**/__velocut/models',route=>{
      const action=route.request().postDataJSON()?.action;
      return action==='list'||action==='connections'
        ?route.fulfill({json:{ok:true,data:{models:[],connections:[]}}})
        :route.fulfill({status:403,json:{ok:false,error:'This test has no configured model host'}});
    });
    await use();
  },{auto:true}],
});
