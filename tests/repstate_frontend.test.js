'use strict';
// RepState frontend regression tests. Run: node tests/repstate_frontend.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function makeDom() {
  const listeners = {};
  const el = (extra={}) => ({ innerHTML:'', textContent:'', value:'', style:{}, hidden:false,
    dataset:{}, classList:{add(){},remove(){},toggle(){}}, appendChild(){}, remove(){},
    addEventListener(){}, removeEventListener(){}, focus(){}, matches(sel){
      if (sel === '[data-change="session-date"]') return this.dataset.change === 'session-date';
      if (sel === '[data-set][data-field]') return this.dataset.set != null && this.dataset.field != null;
      if (sel === '[data-set][data-field], [data-change="session-date"]') return this.matches('[data-set][data-field]') || this.matches('[data-change="session-date"]');
      return false;
    }, closest(){ return this.closestNode || null; }, querySelector(){return null;}, querySelectorAll(){return[];}, ...extra });
  const app=el(), modal=el(), elements={'#app':app,'#modal-root':modal};
  const document={hidden:false,activeElement:null,
    querySelector(s){ return elements[s] || el(); }, querySelectorAll(){return[];}, createElement:()=>el(),
    addEventListener(type,fn){(listeners[type] ||= []).push(fn);},
    dispatch(type,event){for(const fn of listeners[type]||[]) fn(event);}, _elements:elements, _listeners:listeners};
  return {app,modal,document,el};
}
function loadApp(sharedStorage={}, fetchImpl=null) {
  const source=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
  const dom=makeDom();
  const injection=`\n;globalThis.__repstate={document,\n`+
    `getState:()=>state,setState:x=>{state=x;stateSnapshot=JSON.parse(JSON.stringify(x));},\n`+
    `getProgram:()=>program,setProgram:x=>{program=x;},\n`+
    `storage:localStorage,syncInfo,\n`+
    `functions:{loadState,todayISO,parseLocalDate,isoDate,currentWeek,weekRows,uniqueDays,\n`+
    `getPrescription,maxSets,automaticExerciseStatus,statusOf,loggedSetCount,muscleSets,prescribedVolume,copySetValues,\n`+
    `sessionDate,weekStart,hasMeaningfulSyncData,volumeBars,clickAction,syncNow,\n`+
    `mergeSyncData,mergeSyncState:typeof mergeSyncState==='function'?mergeSyncState:null,mergeRecords:typeof mergeRecords==='function'?mergeRecords:null,\n`+
    `normalizeState:typeof normalizeState==='function'?normalizeState:null,resetState:typeof resetState==='function'?resetState:null,\n`+
    `volumeCompletion,validISODate,saveSessionDateInput}\n};\n`;
  const patched=source.replace(/\n\}\)\(\);\s*$/,injection+'\n})();');
  const fetch=fetchImpl || (async()=>({ok:false,status:404,json:async()=>({})}));
  const context={console,document:dom.document,window:{setInterval(){},addEventListener(){},scrollTo(){}},
    localStorage:{getItem(k){return Object.prototype.hasOwnProperty.call(sharedStorage,k)?sharedStorage[k]:null;},setItem(k,v){sharedStorage[k]=String(v);},removeItem(k){delete sharedStorage[k];}},
    sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},fetch,confirm:()=>true,alert(){},
    structuredClone:global.structuredClone,Date,JSON,Math,Number,String,Array,Object,Set,Map,URLSearchParams,Intl,setTimeout,clearTimeout,setInterval(){},clearInterval(){},
    Blob,URL:{createObjectURL(){return 'blob:';},revokeObjectURL(){}}};
  context.globalThis=context; vm.runInNewContext(patched,context,{filename:'public/app.js'});
  return context.__repstate;
}
function max(api,row,w){return api.functions.maxSets(api.functions.getPrescription(row,w).sets);}
function clone(x){return JSON.parse(JSON.stringify(x));}
function actualProgram(){const p=JSON.parse(fs.readFileSync(path.join(__dirname,'..','public','program.json'),'utf8'));p.exercises.forEach((r,i)=>r.id=`${r.week}:${i}`);return p;}
function stateBase(phase='Bulk'){return {settings:{startDate:'2024-01-01',loadUnit:'kg',bodyUnit:'kg',phase},logs:{},checkins:{},sessionDates:{},milestones:{},syncMeta:{},ui:{page:'training',week:1,day:'all',quickLog:true}};}
function completeLogs(api,p,w,phase){
  const logs={}; for(const row of p.exercises.filter(r=>r.week===w)){const n=max(api,row,w);logs[row.id]={sets:Array.from({length:n},()=>({reps:8,load:0}))};} return logs;
}
async function run(){
  const storage={},api=loadApp(storage),f=api.functions,p=actualProgram();api.setProgram(p);api.setState(stateBase());
  const status=f.automaticExerciseStatus; assert(status,'status helper export missing');
  // Actual public program rows receive the same stable IDs as boot(), not synthetic IDs.
  assert.equal(p.exercises[0].id,'1:0');assert.equal(p.exercises.at(-1).id,`44:${p.exercises.length-1}`);
  // Every week, phase, muscle group, and scheduled deload reaches exactly 100% prescribed volume.
  for(const phase of ['Bulk','Cut','Maintenance']) for(let w=1;w<=44;w++){
    api.setState(stateBase(phase));
    api.setState({...api.getState(),logs:completeLogs(api,p,w,phase)});
    const volume=f.prescribedVolume(w), bars=f.volumeBars(w);
    assert(Object.keys(volume).length>=10,`${phase} week ${w} should cover all muscles`);
    for(const [muscle,v] of Object.entries(volume)) assert.equal(v.completed,v.target,`${phase} week ${w} ${muscle} target`);
    assert.equal((bars.match(/style="width:100%"/g)||[]).length,Object.keys(volume).length,`${phase} week ${w} bars`);
    if(p.deloadWeeks.includes(w)) for(const row of p.exercises.filter(r=>r.week===w)) assert.equal(f.getPrescription(row,w).type,'Deload');
  }
  const row=p.exercises.find(r=>r.exercise.includes('Incline DB Bench Press'));
  api.setState(stateBase('Bulk'));
  const required=max(api,row,1);
  assert.equal(status(row,{sets:Array.from({length:required-1},()=>({reps:8,load:1}))}),'Partial','missing prescribed reps is incomplete');
  assert.equal(status(row,{sets:Array.from({length:required},()=>({reps:'',load:100}))}),'Partial','load-only sets do not count');
  const logs={};logs[row.id]={sets:[...Array.from({length:required-1},()=>({reps:8,load:1})),{reps:8,load:1}]};api.setState({...stateBase(),logs});
  const partial=f.prescribedVolume(1).Chest;assert(partial.completed<partial.target,'missing prescribed volume stays below 100%');
  logs[row.id].sets.push({reps:8,load:1,extraSet:true});api.setState({...stateBase(),logs});
  const extra=f.prescribedVolume(1).Chest;assert.equal(extra.extras,1,'extra completed set counted separately');assert(extra.completed<extra.target,'extra set cannot cover missing prescribed set');assert.match(f.volumeBars(1),/\+1 extra/);
  // Date fallback and explicit custom date preserve the immutable week/day identity.
  api.setState({...stateBase(),settings:{...stateBase().settings,startDate:'2024-01-01'},sessionDates:{'1|Tuesday — Lower A':'2024-01-03'}});
  assert.equal(f.sessionDate(1,'Tuesday — Lower A'),'2024-01-03');
  assert.equal(f.sessionDate(1,'Wednesday — Push B'),'2024-01-03');assert.equal(f.sessionDate(1,'Thursday — Pull B'),'2024-01-04');assert.equal(f.sessionDate(1,'Friday — Lower B'),'2024-01-05');
  // Actual document input/change listeners: Tuesday moved to Wednesday; later days remain Thu/Fri/Sat-style ordered dates.
  const input={value:'2024-01-10',dataset:{change:'session-date',week:'1',day:'Tuesday — Lower A'},matches(sel){return sel==='[data-change="session-date"]';}};
  // The document is available through the element listener harness via the exported save helper; exercise both event paths with a fresh load.
  const domApi=loadApp(storage);domApi.setProgram(p);domApi.setState({...stateBase(),settings:{...stateBase().settings,startDate:'2024-01-01'}});
  const dateInput={value:'2024-01-03',dataset:{change:'session-date',week:'1',day:'Tuesday — Lower A'},matches(sel){return sel==='[data-change="session-date"]';}};
  domApi.document.dispatch('change',{target:dateInput});assert.equal(domApi.getState().sessionDates['1|Tuesday — Lower A'],'2024-01-03');
  for(const [day,value] of [['Wednesday — Push B','2024-01-04'],['Thursday — Pull B','2024-01-05'],['Friday — Lower B','2024-01-06']]){
    const later={value,dataset:{change:'session-date',week:'1',day},matches(sel){return sel==='[data-change="session-date"]';}};
    domApi.document.dispatch('change',{target:later});
  }
  assert.equal(domApi.getState().sessionDates['1|Friday — Lower B'],'2024-01-06','remaining sessions can be moved independently');
  dateInput.value='';domApi.document.dispatch('input',{target:dateInput});
  // reload from local storage proves custom date persisted; explicit clear is a tombstone and falls back to plan date.
  const reload=loadApp(storage);reload.setProgram(p);assert.equal(reload.getState().sessionDates['1|Tuesday — Lower A'],'2024-01-03');
  dateInput.value='';reload.functions.saveSessionDateInput(dateInput);assert.equal(reload.getState().sessionDates['1|Tuesday — Lower A'],'');assert.equal(reload.functions.sessionDate(1,'Tuesday — Lower A'),'2024-01-02');
  const invalid={value:'2025-02-29',dataset:{change:'session-date',week:'1',day:'Tuesday — Lower A'}};assert.equal(reload.functions.saveSessionDateInput(invalid),false);assert.equal(reload.functions.validISODate('2025-02-29'),false);
  const todayApi=loadApp({});todayApi.setProgram(p);todayApi.setState(stateBase());
  const todayInput={value:'',dataset:{change:'session-date',week:'1',day:'Tuesday — Lower A'},matches(sel){return sel==='[data-change="session-date"]';}};
  todayApi.document._elements['#session-date']=todayInput;todayApi.functions.clickAction({dataset:{action:'session-date-today'}});
  assert.match(todayInput.value,/^\d{4}-\d{2}-\d{2}$/,'Today action fills an ISO date');assert.equal(todayApi.getState().sessionDates['1|Tuesday — Lower A'],todayInput.value,'Today action saves date');
  // Sync guard: editable date/workout input prevents network sync; valid sync proceeds once focus leaves.
  const calls=[];const syncApi=loadApp({},async(url)=>{calls.push(url);return {ok:true,status:200,json:async()=>({state:{},revision:1})};});calls.length=0;syncApi.setProgram(p);syncApi.syncInfo.loggedIn=true;
  const focused={dataset:{change:'session-date'},matches(sel){return sel==='[data-change="session-date"]';}};syncApi.document.activeElement=focused;await syncApi.functions.syncNow();assert.equal(calls.length,0,'date editing must guard sync');
  syncApi.document.activeElement=null;await syncApi.functions.syncNow();assert(calls.length>=1,'sync runs after date focus ends');
  // Existing add/delete/undo/copy flows remain wired to immutable IDs.
  const flow=loadApp(storage);flow.setProgram(p);const prev=p.exercises.find(r=>r.week===1&&r.exercise===row.exercise),next=p.exercises.find(r=>r.week===2&&r.exercise===row.exercise);flow.setState({...stateBase(),logs:{[prev.id]:{sets:[{load:10,reps:8}]}}});
  flow.functions.clickAction({dataset:{action:'copy-last-exercise',id:next.id}});assert.equal(flow.getState().logs[next.id].sets[0].load,10,'copy flow');
  flow.functions.clickAction({dataset:{action:'add-set',id:next.id}});assert(flow.getState().logs[next.id].sets.length>max(flow,next,2),'add flow');
  const extraIndex=flow.getState().logs[next.id].sets.length-1;flow.functions.clickAction({dataset:{action:'delete-set',id:next.id,setIndex:String(extraIndex)}});assert.equal(flow.getState().logs[next.id].sets.length,max(flow,next,2),'delete flow');flow.functions.clickAction({dataset:{action:'undo-delete-set'}});assert.equal(flow.getState().logs[next.id].sets.length,max(flow,next,2)+1,'undo flow');
  console.log('frontend RepState regression tests: PASS');
}
run().catch(e=>{console.error('frontend RepState regression tests: FAIL\n'+e.stack);process.exitCode=1;});
