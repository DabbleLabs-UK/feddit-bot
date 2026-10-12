'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feddit-continuation-integration-'));
process.env.FEDDIT_BOT_DATA_DIR=dir;
const store=require('../lib/store'),{createScheduler}=require('../lib/scheduler');
const guard=require('../lib/continuation-guard'),receipt=require('../lib/discovery-receipt');
let checks=0,clock=Date.UTC(2026,9,12,12),mode='choose',calls=0,writes=0,events=[],renewed=[];
const eq=(a,b,n)=>{assert.deepEqual(a,b,n);checks++;};
const ok=(a,n)=>{assert.ok(a,n);checks++;};
function attentionEvent(id,postId=42){
 return {event_id:'t1_'+id,type:'reply_to_own_comment',source_type:'comment',comment_id:id,post_id:postId,
  author:'other_'+id,community:'general',created_utc:Math.floor(clock/1000),body:'A real direct reply '+id,
  context:{post:{post_id:postId,author:'thread_author',community:'general',title:'A conversation'}}};
}
const feddit={
 attention:async(_token,o)=>({ok:true,data:{events:events.filter(e=>e.comment_id>o.afterComment),
  cursor:{comments:Math.max(o.afterComment,...events.map(e=>e.comment_id),0),posts:o.afterPost},has_more:false}}),
 activeThreads:async()=>({ok:true,data:{threads:renewed}}),
 feddit:async()=>({ok:true,data:{data:{children:[]}}}),
 comments:async()=>({ok:true,data:{comments:[]}}),
 comment:async()=>{writes++;return{ok:true,status:200,data:{comment:{data:{id:1000+writes}}}};},
};
const providers={ollamaBusy:()=>false,generate:async(o)=>{
 calls++;return{text:/decision/.test(o.kind)?(mode==='invalid'?'malformed response':JSON.stringify({choice:mode==='wait'?'WAIT':'C1',reason:'The offered context fits.'})):'A bounded reply.',
 usage:{inputTokens:10,outputTokens:10},ms:1};
}};
function create(name){
 const p=store.createProfile({fedditUsername:name,token:'fixture-'+name,enabled:true,dryRun:false,provider:'deepseek',
  canReply:true,canStartDiscussions:false,canShareLinks:false,canVote:false,postsPerHour:0,articlePostsPerHour:0,
  commentsPerHour:1,postFeddits:['general'],readFeddits:['general'],persona:'A test character.',
  probation:{onProbation:false,checkedAt:clock}});
 store.updateSched(p.id,{nextPostAt:null,nextArticleAt:null,nextCommentAt:0});
 return p;
}
function scheduler(){return createScheduler({store,feddit,providers,now:()=>clock,random:()=>0.5,
 getDeepseekKey:()=> 'fixture-only-key',about:{fetchAbout:async()=>({name:'general',over_18:false,rules:[]})}});}
async function due(p){store.updateSched(p.id,{nextCommentAt:0});await scheduler().runTick();}
(async()=>{
try{
 // Real store and real scheduler, entirely mocked provider/publication boundary.
 const bots=Array.from({length:12},(_,i)=>create('independent_'+i));
 events=[attentionEvent(100)];
 await scheduler().runTick();
 eq(writes,12,'twelve independent bots continue one thread beyond both old ceilings');
 eq(calls,24,'each eligible bot chooses and writes through the existing two mocked calls');
 for(const p of bots) eq(store.getThreadReplyCount(42,{profileId:p.id,continuationVersion:2,nowMs:clock}),1,'only that bot owns its attempt');
 eq(store.getThreadReplyCount(42),0,'new turns do not mutate the old runner ledger');
 bots.forEach(p=>store.updateProfile(p.id,{enabled:false}));
 const loop=create('loop_guard');
 for(let i=0;i<3;i++){events=[attentionEvent(201+i)];await due(loop);}
 const before=calls,prior=writes;
 events=[attentionEvent(204)];
 await due(loop);
 eq(calls,before,'fourth rapid same-bot attempt never reaches inference');
 eq(writes,prior,'fourth attempt does not publish');
 ok(!store.getAttentionState(loop.id).seenEventIds.includes('t1_204'),'guard-filtered attention is not consumed');
 ok(store.getAttentionState(loop.id).cursor.comments<204,'cursor cannot jump beyond unoffered guard-filtered event');
 clock+=guard.WINDOW_MS+1;
 await due(loop);
 eq(writes,prior+1,'the same bot can naturally return after the rolling window');
 ok(store.getAttentionState(loop.id).seenEventIds.includes('t1_204'),'handled event then advances state');
 store.updateProfile(loop.id,{enabled:false});

 const waiting=create('wait_is_valid');mode='wait';
 events=Array.from({length:8},(_,i)=>({...attentionEvent(301+i,43),created_utc:Math.floor(clock/1000)-(7-i)}));
 await due(waiting);
 const first=store.getAttentionState(waiting.id);
 eq(first.seenEventIds.length,4,'valid WAIT handles only the four actually offered attention items');
 eq(first.cursor.comments,300,'higher handled IDs cannot skip lower unoffered events');
 eq(store.getProfile(waiting.id).repliedTo.length,0,'WAIT does not pretend to have replied');
 await due(waiting);
 const second=store.getAttentionState(waiting.id);
 eq(second.seenEventIds.length,8,'remaining fetched events are available on the next normal opportunity');
 eq(second.cursor.comments,308,'cursor advances after the remaining events are handled');
 store.updateProfile(waiting.id,{enabled:false});

 const recovered=create('missed_attention_receipt');mode='wait';
 store.recordReplied(recovered.id,'t1_401');
 events=[attentionEvent(401,44),attentionEvent(402,44)];
 await due(recovered);
 eq(store.getAttentionState(recovered.id).cursor.comments,402,'existing handled target does not permanently pin an attention cursor after an outage');
 ok(store.getAttentionState(recovered.id).seenEventIds.includes('t1_401'),'prior reply dedupe supplies separate handled evidence');
 events=[attentionEvent(403,44)];mode='invalid';
 await due(recovered);
 ok(!store.getAttentionState(recovered.id).seenEventIds.includes('t1_403'),'malformed model decision does not consume pending discovery');
 eq(store.getAttentionState(recovered.id).cursor.comments,402,'technical failure retains the committed cursor boundary');
 mode='wait';await due(recovered);
 eq(store.getAttentionState(recovered.id).cursor.comments,403,'a later valid handled opportunity can advance the unresolved event');
 store.updateProfile(recovered.id,{enabled:false});

 const snap={attentionScan:{startCursor:{comments:10,posts:0},cursor:{comments:12,posts:0},
  seenEventIds:['t1_11','t1_12'],pendingEventIds:['t1_11','t1_12']},
  activeThreadScan:{consideredEventIds:['active:t1_11','active:t1_12']}};
 const noOffer=receipt.plan(snap,{valid:false,candidates:[],votes:[]});
 eq(noOffer.attentionScan.cursor.comments,10,'technical/no-offer failure retains attention');
 eq(noOffer.activeThreadScan.consideredEventIds,[],'unoffered renewed thread remains discoverable');
 const rootVote=receipt.plan(snap,{valid:false,candidates:[],votes:[{decisionKind:'explicit',status:'no-vote',targetType:'post',targetId:42}]});
 eq(rootVote.activeThreadScan.consideredEventIds,[],'voting on a root cannot consume its fresh reply event');
 const exactVote=receipt.plan(snap,{valid:false,candidates:[],votes:[{decisionKind:'explicit',status:'no-vote',targetType:'comment',targetId:12}]});
 eq(exactVote.activeThreadScan.consideredEventIds,['active:t1_12'],'explicit vote on the exact fresh target is handled');
 eq(exactVote.attentionScan.cursor.comments,10,'a separately handled later vote cannot skip an earlier pending reply');
 const valid=receipt.plan(snap,{valid:true,candidates:[{target:{key:'t1_11'}}],votes:[]});
 eq(valid.activeThreadScan.consideredEventIds,['active:t1_11'],'valid primary handling advances only the offered renewed event');
 console.log('conversation continuation: '+checks+' checks passed');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
