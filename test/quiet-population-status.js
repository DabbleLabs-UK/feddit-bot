'use strict';
const assert=require('node:assert/strict');
const {createQuietConversations}=require('../lib/quiet-conversations');
let at=Date.UTC(2026,9,28,16),calls=0,checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const iso=n=>new Date(n).toISOString();
const snapshot=()=>({schemaVersion:1,source:'feddit-current-votes',generatedAt:iso(at),
 window:{hours:1,since:iso(at-3600000),until:iso(at)},coverage:{sampleTruncated:false,nsfwIncluded:false},items:[]});
const profiles=Array.from({length:8},(_,n)=>({id:'p_'+n,enabled:true,token:'DO_NOT_COPY_SECRET',provider:'dell',dryRun:false,
 activity:[{at:iso(at-1000),kind:'decision',ok:true,dryRun:false,assessmentCandidates:1}]}));
const samples=Array.from({length:4},(_,n)=>({startedAt:at-(n+1)*60000,finishedAt:at-n*60000,status:'completed'}));
async function main(){
 const c=createQuietConversations({file:'NEVER_READ_OR_WRITE',enabled:true,populationAware:true,now:()=>at,
  request:async()=>{calls++;return{ok:true,data:snapshot()};}});
 eq(c.status().evaluation,null);eq(c.status().stale,true);eq(calls,0);
 await c.getSignal({profiles,samples});
 const s=c.status();eq(calls,1);eq(s.evaluation.mode,'adaptive');eq(s.evaluation.signal.policy.activeProfiles,8);
 eq([s.evaluation.signal.policy.low,s.evaluation.signal.policy.high,s.evaluation.signal.policy.gapMs],[8,12,900000]);
 eq(s.stale,false);eq(JSON.stringify(s).includes('DO_NOT_COPY_SECRET'),false);eq(JSON.stringify(s).includes('p_0'),false);
 s.evaluation.signal.policy.activeProfiles=999;eq(c.status().evaluation.signal.policy.activeProfiles,8);eq(calls,1);
 at+=300001;eq(c.status().stale,true);eq(calls,1);
 await c.getSignal({profiles,samples:[{startedAt:at-800000,finishedAt:at-1000,status:'completed'}]});
 eq(c.status().evaluation.mode,'suppressed');eq(c.status().evaluation.reason,'insufficient-measured-capacity');
 const fixed=createQuietConversations({enabled:true,now:()=>at,request:async()=>({ok:true,data:snapshot()})});
 await fixed.getSignal();eq(fixed.status().evaluation.mode,'fixed');
 const fallback=createQuietConversations({enabled:true,populationAware:true,now:()=>at,request:async()=>({ok:true,data:snapshot()})});
 await fallback.getSignal({profiles,samples:[]});eq(fallback.status().evaluation.mode,'fixed-fallback');
 console.log('quiet-population-status: '+checks+' checks passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
