'use strict';
const assert = require('node:assert/strict');
const envelope = require('../lib/hosted-decision-envelope');
const action = require('../lib/action-candidates');
const voting = require('../lib/voting');
let checks = 0;
const eq = (a,b,why) => { assert.deepEqual(a,b,why); checks++; };
const options = { outputTokens: 100, outputLimit: 640 };
const decode = text => envelope.decode(text, options);
const menu = [{ id: 'C8', action: 'comment' }];
const votes = [{ id:'V1',targetType:'post',targetId:1 },{ id:'V2',targetType:'comment',targetId:2 }];
const parse = text => action.parseDecision(text,menu,{decisionContractVersion:2,voteCandidates:votes});
const valid = '{"choice":"C8","reason":"A relevant question.","votes":[{"id":"V1","direction":"up","reason":"An interesting public question."}]}';
const missingClose = valid.slice(0,-1);
const missingQuote = valid.replace(',"votes":',',votes":');
eq(envelope.version(),0); eq(envelope.version(0),0); eq(envelope.version(1),1);
for(const value of [2,'1',false,{},[]]) { assert.throws(()=>envelope.version(value),{code:'UNSUPPORTED_HOSTED_DECISION_ENVELOPE'}); checks++; }
for(const [raw,kind] of [[missingClose,'missing-root-close'],[missingQuote,'missing-votes-key-opening-quote']]) {
 const repaired=decode(raw);
 eq(repaired,{text:valid,repair:kind}); eq(parse(raw).valid,false); eq(parse(repaired.text).valid,true);
 eq(parse(repaired.text),parse(valid),'semantic validator sees only original explicit values');
 eq(parse(repaired.text).votes[0].direction,'up'); eq(parse(repaired.text).votes[1].direction,null);
 eq(parse(repaired.text).votes[1].status,'unresolved');
 eq(voting.record({},parse(repaired.text).votes).considered,['post:1']);
}
for(const choice of ['C8','WAIT']) for(const direction of ['up','down','nil']) {
 const text=JSON.stringify({choice,reason:'A relevant public item.',votes:[{id:'V1',direction,reason:'An interesting public question.'}]});
 eq(decode(text),{text,repair:null});
 eq(parse(decode(text).text),parse(text));
 const repaired=parse(decode(text.slice(0,-1)).text);
 eq(repaired.valid,true); eq(repaired.waited,choice==='WAIT'); eq(repaired.votes[0].direction,direction);
 eq(repaired.votes[1].status,'unresolved','missing independent item is not inferred from WAIT/NIL');
}
const unresolved=JSON.stringify({choice:'C8',reason:'A relevant question.',votes:[
 {id:'V1',direction:'up',reason:'An interesting public question.'},{id:'V1',direction:'nil'}]}).slice(0,-1);
const duplicateVote=parse(decode(unresolved).text);
eq(duplicateVote.valid,true); eq(duplicateVote.votes[0].status,'unresolved');
eq(voting.record({},duplicateVote.votes).considered,[],'conflicting vote entries remain unresolved');
const invalidReason=parse(decode(valid.replace('An interesting public question.','yes').slice(0,-1)).text);
eq(invalidReason.valid,true); eq(invalidReason.votes[0].status,'unresolved');
const unknown=parse(decode(valid.replace('C8','C99').slice(0,-1)).text);
eq(unknown.valid,false); eq(unknown.technicalFailure,true,'unknown action cannot become WAIT');
for(const raw of [
 missingQuote.slice(0,-1), // Never chain repairs.
 valid.replace('"A relevant question."','"A relevant question,'),
 valid.replace('"A relevant question.",','"A relevant question."'),
 valid.replace(',"votes":',',votes:'),
 valid.slice(0,-2), valid.slice(0,-3), // No nested array/object completion.
 missingClose+'|', missingClose+' commentary', 'Answer: '+missingClose,
 '{"choice":"C8","choice":"WAIT","reason":"A relevant question.","votes":[]',
 '{"choice":"C8","reason":"A relevant question.","reason":"Another reason.","votes":[]',
 '{"choice":"C8","reason":"A relevant question.","votes":[{"id":"V1","id":"V2","direction":"nil"}]',
 '{"choice":"C8","reason":"A relevant question.","votes":[],"votes":[]',
 '{"reason":"A relevant question.","votes":[]',
 '{"choice":"C8","votes":[]',
 '{"choice":"C8","reason":"A relevant question.","votes":null',
 '{"choice":"C8","reason":"A relevant question.","votes":[],"choice2":"WAIT"',
 '[{"choice":"C8","reason":"A relevant question.","votes":[]}]',
 '```json\n'+missingClose+'\n```',
 missingQuote+'\n```', missingQuote+'\n```json',
 '{"choice":"C8","reason":"Quoted ,votes":[ material","votes":[]',
]) {
 eq(decode(raw),{text:raw.trim(),repair:null},'outside the two proven single-punctuation patterns');
 // A complete array still fails the existing root-object validator.
 eq(parse(decode(raw).text).valid,false);
}
for(const metadata of [{},{outputTokens:640,outputLimit:640},{outputTokens:641,outputLimit:640},
 {outputTokens:null,outputLimit:640},{outputTokens:'100',outputLimit:640},
 {outputTokens:0,outputLimit:640},{outputTokens:100,outputLimit:NaN},{outputTokens:1.5,outputLimit:640}]) {
 eq(envelope.decode(missingClose,metadata),{text:missingClose,repair:null},'missing/exhausted/invalid telemetry cannot grant repair');
}
for(const text of [valid,'```json\n'+valid+'\n```',JSON.stringify({choice:'WAIT',reason:'The word ,votes" occurs in this string.',votes:[]})]) {
 eq(decode(text),{text,repair:null});
}
console.log('hosted decision envelope: '+checks+' checks passed');
