'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createObserver, legacyEvents, windowHours, authorised } = require('../lib/naturalness-observer');

async function main() {
  assert.equal(authorised('desktop', false), true);
  assert.equal(authorised('advanced', false), true);
  assert.equal(authorised('hosted', false), false);
  assert.equal(authorised('hosted', true), true);
  assert.equal(windowHours(168), 168);
  assert.equal(windowHours(Infinity), 24);
  const now = Date.parse('2026-10-07T00:00:00Z');
  const profiles = [{id:'a',fedditUsername:'alpha',persona:'PRIVATE PERSONA',populationProvenance:{cohortId:'cohort'},activity:[{
    at:new Date(now - 10000).toISOString(),kind:'vote',votes:[{targetType:'post',targetId:1,direction:'nil',status:'no-vote'}],
  }]}];
  const original = JSON.stringify(profiles);
  const legacy = legacyEvents(profiles);
  assert.equal(legacy[0].items[0].decisionKind, 'unknown');
  assert.equal(legacy[0].stage, 'outcome');
  assert.equal(legacy[0].cohort, 'cohort');
  assert(!JSON.stringify(legacy).includes('PRIVATE PERSONA'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'feddit-observer-'));
  const authoritative = {schemaVersion:1,source:'feddit-current-votes',generatedAt:new Date(now).toISOString(),items:[]};
  fs.writeFileSync(path.join(dir,'naturalness-authoritative.json'),JSON.stringify(authoritative));
  const before = fs.readFileSync(path.join(dir,'naturalness-authoritative.json'),'utf8');
  let calls = 0;
  const store = {list:()=>[{profileId:'a',at:new Date(now).toISOString()},{profileId:'other-owner',at:new Date(now).toISOString()}]};
  const create = (request) => createObserver({dataDir:dir,request,evidenceStore:store,now:()=>now,
    buildSnapshot: ({events,authoritative,hours})=>({events,authoritative,hours,coverage:{warnings:[]}})});
  try {
    const observer = create(async (url,options) => {
      calls++; assert.equal(url,'/evidence.json?window_hours=24&limit=100');
      assert.equal(options.timeoutMs,5000); assert.equal(options.token,undefined);
      return {ok:false,status:404};
    });
    const result = await observer.snapshot({hours:24,profiles});
    assert.equal(calls,1,'no automatic retry');
    assert.equal(result.coverage.authoritativeCapture,'operator-read-only-snapshot');
    assert(result.events.every(event=>event.profileId==='a'),'private owner filter');
    assert.equal(fs.readFileSync(path.join(dir,'naturalness-authoritative.json'),'utf8'),before,'snapshot read never writes');
    assert.equal(JSON.stringify(profiles),original,'profiles unchanged');
    const gates=[];
    const parallel=create(()=>new Promise(resolve=>gates.push(resolve)));
    const a=parallel.snapshot({hours:24,profiles});
    const same=parallel.snapshot({hours:24,profiles});
    const b=parallel.snapshot({hours:24,profiles:[{id:'other-owner'}]});
    assert.equal(gates.length,2,'coalescing never shares scopes');
    gates.forEach(resolve=>resolve({ok:true,data:authoritative}));
    const [ra,rs,rb]=await Promise.all([a,same,b]);
    assert.deepEqual(ra,rs);
    assert(rb.events.every(event=>event.profileId==='other-owner'));
    fs.unlinkSync(path.join(dir,'naturalness-authoritative.json'));
    const missing=await observer.snapshot({hours:24,profiles:[]});
    assert.equal(missing.authoritative,null);
    assert.equal(missing.coverage.authoritativeCapture,'unavailable');
    console.log('PASS naturalness observer: isolation, legacy uncertainty, read-only fallback, no retries, no mutation');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
