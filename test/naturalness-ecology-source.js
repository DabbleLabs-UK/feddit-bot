'use strict';
const assert = require('node:assert/strict');
const { createEcologySource, threadItems, postItem, LIMITS } = require('../lib/naturalness-ecology-source');
const stamp = Date.parse('2026-10-08T12:00:00Z');
const post = n => ({kind:'t3',data:{id:n,feddit:'botlife',author:'public_bot',created_utc:stamp/1000,title:'Public title',selftext:'Body',kind:'text',num_comments:2}});
const comment = (n, parent = null) => ({kind:'t1',data:{id:n,post_id:1,parent_id:parent,author:'other_bot',created_utc:stamp/1000,body:'Public reply',replies:''}});
(async () => {
  const raw={post:post(1),comments:{data:{children:[comment(1),comment(2,'t1_1')]}}};
  const before=JSON.stringify(raw), rows=threadItems(raw);
  assert.equal(rows[1].parentKey,'post:1'); assert.equal(rows[2].parentKey,'comment:1');
  assert.equal(JSON.stringify(raw),before); assert.equal(postItem({kind:'t3',data:{...post(1).data,over_18:true}}),null);
  assert.equal(threadItems({post:{kind:'t3',data:{...post(1).data,over_18:true}},comments:raw.comments}).length,0);
  assert.equal(postItem({kind:'t3',data:{...post(1).data,selftext:'x'.repeat(10000)}}).text.length,4000);
  let calls=[];
  const source=createEcologySource({now:()=>stamp,request:async(route,options)=>{
    calls.push(route); assert(!options.token && !options.body && !options.method,'only public GET, no credentials');
    if(route.startsWith('/front/new'))return {ok:true,data:{data:{after:null,children:[post(1)]}}};
    if(route==='/feddits')return {ok:true,data:{feddits:[{name:'botlife',description:'Public rules',secret:'NEVER EXPORT'}]}};
    return {ok:true,data:raw};
  }});
  const options={since:'2026-10-07T12:00:00Z',until:'2026-10-08T12:00:00Z',votingSnapshot:{items:[]}};
  const [a,b]=await Promise.all([source.snapshot(options),source.snapshot(options)]);
  assert.equal(calls.length,3,'concurrent reads coalesce'); assert.deepEqual(a,b); assert.equal(a.items.length,3);
  assert(a.coverage.postsComplete && !a.coverage.commentsComplete); assert(!JSON.stringify(a).includes('NEVER EXPORT'));
  calls=[];
  const bounded=createEcologySource({now:()=>stamp,request:async route=>{
    calls.push(route);
    if(route.startsWith('/front/new'))return {ok:true,data:{data:{after:'100',children:Array.from({length:100},(_,i)=>post(i+1))}}};
    return {ok:false};
  }});
  const partial=await bounded.snapshot(options);
  assert(calls.length<=LIMITS.requests); assert(calls.filter(x=>x.startsWith('/comments/')).length<=16);
  assert(partial.coverage.truncated); assert(partial.coverage.failedReads>0);
  assert(partial.coverage.warnings.some(x=>x.includes('No retries')));
  const unavailable=await createEcologySource({request:async()=>{throw Error('SECRET');}}).snapshot(options);
  assert.equal(unavailable.items.length,0); assert(!unavailable.coverage.postsComplete); assert(!JSON.stringify(unavailable).includes('SECRET'));
  console.log('PASS ecology source: public read bounds, no mutations/credentials, thread parents, sampling, coalescing, failure gaps');
})().catch(error=>{console.error(error);process.exitCode=1;});
