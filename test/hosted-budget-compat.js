'use strict';
// Mock server only. Preserve the deployed non-streaming transport and timeout.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),zlib=require('node:zlib'),path=require('node:path');
let checks=0;const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
async function run(){
  const calls=[];const server=http.createServer(async(req,res)=>{let s='';for await(const b of req)s+=b;calls.push({path:req.url,body:s?JSON.parse(s):null});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:{content:'{"choice":"WAIT","votes":[]}'},prompt_eval_count:12,eval_count:10}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.OLLAMA_BASE='http://127.0.0.1:'+server.address().port;
  const ollama=require('../lib/providers/ollama'),budget=require('../lib/hosted-decision-budget'),tokenizer=require('../lib/hosted-tokenizer');
  const data=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,'../lib/hosted-tokenizer-data.json.gz'))));
  const show={template:data.template,parameters:'stop                           "<|im_start|>"\nstop                           "<|im_end|>"',model_info:data.tokenizer};
  let acquired=0,released=0,metadata=0;
  const leaseClient={acquire:async()=>{acquired++;return{profile:{num_ctx:3072,num_thread:4},release:async()=>{released++;}};}};
  const metadataTransport=async route=>{metadata++;return route==='/api/version'?{version:'0.34.1'}:route==='/api/tags'?{models:[{name:tokenizer.MODEL,digest:tokenizer.MANIFEST_SHA256}]}:show;};
  const request={model:tokenizer.MODEL,system:'Complete persona',prompt:'Complete frozen decision',numPredict:640,timeoutMs:300000,hostedDecision:true,leaseClient,metadataTransport};
  request.decisionBudget=budget.measure(request.system,request.prompt,request.numPredict);
  try{
    await ollama.generate(request);eq(calls.length,1,'one fitting inference');eq(metadata,3,'all metadata verified');eq(calls[0].body.stream,false,'existing non-streaming transport retained');eq(calls[0].body.keep_alive,-1,'model residency retained');eq(calls[0].body.options.num_ctx,3072,'context unchanged');eq(calls[0].body.options.num_thread,4,'threads unchanged');eq(calls[0].body.options.num_predict,640,'output allowance retained');
    await assert.rejects(()=>ollama.generate({...request,prompt:'tampered'}),e=>e.code==='HOSTED_DECISION_BUDGET');checks++;eq(calls.length,1,'tampered budget sends no inference');
    await assert.rejects(()=>ollama.generate({...request,prompt:'Unbounded context '.repeat(4000),decisionBudget:null}),e=>e.code==='HOSTED_DECISION_BUDGET');checks++;eq(calls.length,1,'oversized legacy request sends no inference');
    await assert.rejects(()=>ollama.generate({...request,metadataTransport:async()=>({version:'unknown'})}),e=>e.code==='HOSTED_DECISION_BUDGET');checks++;eq(calls.length,1,'unverified metadata sends no inference');
    eq(released,acquired,'leases released on success and refusal');eq(ollama.isBusy(),false,'busy state clears');
    const before=metadata;await ollama.generate({...request,hostedDecision:false});eq(metadata,before,'ordinary content path unchanged');eq(calls[1].body.stream,false,'ordinary transport unchanged');
    const {createWorker}=require('../worker');let payload,reported;
    const worker=createWorker({runnerUrl:'https://fixture.invalid',key:'fixture',generate:async p=>{payload=p;throw budget.failure('Fixture refusal');},fetchImpl:async(_,opts)=>{reported=JSON.parse(opts.body);return{ok:true,text:async()=>'{}'};},logger:{log(){},error(){}}});
    await worker.runJob({id:'fixture',kind:'scheduled-decision',payload:{model:tokenizer.MODEL,system:request.system,prompt:request.prompt,decisionBudget:request.decisionBudget}});
    eq(payload.hostedDecision,true,'decision guard routed');eq(payload.decisionBudget,request.decisionBudget,'frozen budget delivered');eq(payload.timeoutMs,300000,'deployed five-minute hosted deadline retained');eq(reported.retryable,false,'deterministic refusal is not retried');
    console.log('hosted worker budget compatibility: '+checks+' checks passed');
  }finally{await new Promise(r=>server.close(r));}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
