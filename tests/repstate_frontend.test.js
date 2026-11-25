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
  const injection=`\n;globalThis.__repstate={document,app:document.querySelector('#app'),\n`+
    `getState:()=>state,setState:x=>{state=x;stateSnapshot=JSON.parse(JSON.stringify(x));},\n`+
    `getProgram:()=>program,setProgram:x=>{program=x;},\n`+
    `storage:localStorage,syncInfo,\n`+
    `functions:{loadState,todayISO,parseLocalDate,isoDate,currentWeek,weekRows,uniqueDays,validWeek,syncData,applySyncData,\n`+
    `getPrescription,maxSets,automaticExerciseStatus,statusOf,loggedSetCount,muscleSets,prescribedVolume,copySetValues,\n`+
    `sessionDate,weekStart,sessionForDate,nextPlannedSession,overviewSession,navigateToSession,hasMeaningfulSyncData,volumeBars,clickAction,syncNow,\n`+
    `mergeSyncData,mergeSyncState:typeof mergeSyncState==='function'?mergeSyncState:null,mergeRecords:typeof mergeRecords==='function'?mergeRecords:null,\n`+
    `normalizeState:typeof normalizeState==='function'?normalizeState:null,resetState:typeof resetState==='function'?resetState:null,\n`+
    `volumeCompletion,validISODate,saveSessionDateInput,\n`+
    `ensureSessionDate:typeof ensureSessionDate==='function'?ensureSessionDate:null,\n`+
    `advanceCompletedWeek:typeof advanceCompletedWeek==='function'?advanceCompletedWeek:null}};\n`;
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
function actualProgram(){const p=JSON.parse(fs.readFileSync(path.join(__dirname,'..','public','program.json'),'utf8'));p.exercises.forEach((r,i)=>r.id=`${r.week}:${i}`);return p;}
function stateBase(phase='Bulk'){return {settings:{startDate:'2024-01-01',loadUnit:'kg',bodyUnit:'kg',phase},logs:{},checkins:{},sessionDates:{},milestones:{},syncMeta:{},ui:{page:'training',week:1,day:'all',quickLog:true}};}
function completeLogs(api,p,w,status='Done'){const logs={}; for(const row of p.exercises.filter(r=>r.week===w)){const n=max(api,row,w);logs[row.id]={status,sets:status==='Done'?Array.from({length:n},()=>({reps:8,load:0})):[]};} return logs;}
function setFor(api,p,w,status='Done'){return completeLogs(api,p,w,status);}
function assertOptional(fn, message){assert.equal(typeof fn,'function',message);}

async function run(){
  const storage={},api=loadApp(storage),f=api.functions,p=actualProgram();api.setProgram(p);api.setState(stateBase());
  assertOptional(f.advanceCompletedWeek,'advanceCompletedWeek helper export missing');
  assertOptional(f.ensureSessionDate,'ensureSessionDate helper export missing');
  assert.equal(p.exercises[0].id,'1:0');assert.equal(p.exercises.at(-1).id,`44:${p.exercises.length-1}`);

  // currentWeek ignores calendar/startDate drift and follows explicit progression evidence.
  api.setState(stateBase()); assert.equal(f.currentWeek(),1,'empty state defaults to Week 1');
  api.setState({...stateBase(),logs:{'2:calendar-skip':{status:'Skipped',sets:[]}}});
  assert.equal(f.currentWeek(),2,'a skipped calendar week is the highest completed/evidenced week');
  api.setState({...stateBase(),logs:{'3:real-set':{sets:[{reps:8,load:20}]}}});
  assert.equal(f.currentWeek(),3,'a real logged set establishes the current week');
  api.setState({...stateBase(),settings:{...stateBase().settings,activeWeek:9},logs:{'3:real-set':{sets:[{reps:8,load:20}]}}});
  assert.equal(f.currentWeek(),9,'valid persisted activeWeek wins over inferred progress');
  api.setState({...stateBase(),settings:{...stateBase().settings,activeWeek:45}});assert.equal(f.currentWeek(),1,'invalid activeWeek is ignored');

  // Advance only after every row is Done/Skipped, with at least one Done; it persists once and caps at 44.
  api.setState({...stateBase(),settings:{...stateBase().settings,activeWeek:2},logs:setFor(api,p,2,'Skipped')});
  assert.equal(f.advanceCompletedWeek(),false,'all-skipped week cannot advance');assert.equal(api.getState().settings.activeWeek,2);
  const mixed=setFor(api,p,2,'Skipped');mixed[p.exercises.find(r=>r.week===2).id]={status:'Done',sets:[]};
  api.setState({...stateBase(),settings:{...stateBase().settings,activeWeek:2},logs:mixed});
  assert.equal(f.advanceCompletedWeek(),true,'Done plus Skipped rows advances');assert.equal(api.getState().settings.activeWeek,3);
  assert.equal(f.advanceCompletedWeek(),false,'advance is not repeated without completing the new week');assert.equal(api.getState().settings.activeWeek,3);
  api.setState({...stateBase(),settings:{...stateBase().settings,activeWeek:44},logs:setFor(api,p,44,'Done')});
  const before44=JSON.stringify(api.getState().logs);assert.equal(f.advanceCompletedWeek(),false,'Week 44 does not wrap');assert.equal(api.getState().settings.activeWeek,44);assert.equal(JSON.stringify(api.getState().logs),before44,'Week 44 leaves records intact');

  // Every phase and week still reaches exactly 100% prescribed volume.
  for(const phase of ['Bulk','Cut','Maintenance']) for(let w=1;w<=44;w++){
    api.setState(stateBase(phase));api.setState({...api.getState(),logs:completeLogs(api,p,w)});
    const volume=f.prescribedVolume(w), bars=f.volumeBars(w);assert(Object.keys(volume).length>=10,`${phase} week ${w} should cover all muscles`);
    for(const [muscle,v] of Object.entries(volume)) assert.equal(v.completed,v.target,`${phase} week ${w} ${muscle} target`);
    assert.equal((bars.match(/style="width:100%"/g)||[]).length,Object.keys(volume).length,`${phase} week ${w} bars`);
  }

  // Logged but incomplete prescribed sets stay partial; extra sets cannot fill missing targets.
  const statusRow=p.exercises.find(r=>r.week===1&&r.exercise.includes('Incline DB Bench Press'));
  api.setState(stateBase());
  const required=max(api,statusRow,1);
  assert.equal(f.automaticExerciseStatus(statusRow,{sets:Array.from({length:required-1},()=>({reps:8,load:1}))}),'Partial');
  assert.equal(f.automaticExerciseStatus(statusRow,{sets:Array.from({length:required},()=>({reps:'',load:100}))}),'Partial');
  const extras=Array.from({length:required-1},()=>({reps:8,load:1})).concat([{reps:'',load:1},{reps:8,load:1,extraSet:true}]);
  api.setState({...stateBase(),logs:{[statusRow.id]:{sets:extras}}});
  assert.equal(f.prescribedVolume(1).Chest.extras,1);
  assert(f.prescribedVolume(1).Chest.completed<f.prescribedVolume(1).Chest.target);

  // First load/reps, Finish workout, and copy establish a date only when the key is absent.
  const row=p.exercises.find(r=>r.exercise.includes('Incline DB Bench Press')), key=`1|${row.day}`;
  api.setState(stateBase());f.ensureSessionDate(1,row.day);assert.match(api.getState().sessionDates[key],/^\d{4}-\d{2}-\d{2}$/,'missing date is initialized to today');
  api.getState().sessionDates[key]='';f.ensureSessionDate(1,row.day);assert.equal(api.getState().sessionDates[key],'','existing empty date is preserved');
  api.getState().sessionDates={};f.ensureSessionDate(1,row.day);assert.match(api.getState().sessionDates[key],/^\d{4}-\d{2}-\d{2}$/,'first logging creates a session date');
  api.getState().sessionDates[key]='2026-01-09';f.ensureSessionDate(1,row.day);assert.equal(api.getState().sessionDates[key],'2026-01-09','existing date is preserved');
  const copied=p.exercises.find(r=>r.week===2&&r.exercise===row.exercise);api.setState({...stateBase(),logs:{[row.id]:{sets:[{load:10,reps:8}]}}});
  f.clickAction({dataset:{action:'copy-last-exercise',id:copied.id}});assert(api.getState().sessionDates[`2|${copied.day}`],'copy creates the target session date');
  api.setState({...stateBase(),logs:{}});f.clickAction({dataset:{action:'mark-day',week:'1',day:row.day}});assert(api.getState().sessionDates[key],'Finish workout creates a session date');

  // Manual correction is saved but cannot erase a date; invalid dates are rejected.
  const input={value:'2026-02-03',dataset:{change:'session-date',week:'1',day:row.day},matches(sel){return sel==='[data-change="session-date"]';}};
  api.setState({...stateBase(),sessionDates:{[key]:'2026-01-09'}});assert.equal(f.saveSessionDateInput(input),true);assert.equal(api.getState().sessionDates[key],'2026-02-03');
  input.value='';assert.equal(f.saveSessionDateInput(input),false,'manual date changes cannot clear a saved date');assert.equal(api.getState().sessionDates[key],'2026-02-03');
  input.value='2025-02-29';assert.equal(f.saveSessionDateInput(input),false);assert.equal(api.getState().sessionDates[key],'2026-02-03');

  // The real delegated date-input event saves an actual valid date, while invalid/empty edits preserve it.
  api.setState({...stateBase(),sessionDates:{[key]:'2026-02-03'}});
  const dateEventInput={value:'2026-03-14',id:'session-date',dataset:{change:'session-date',week:'1',day:row.day},matches(sel){return sel==='[data-set][data-field]'||sel==='[data-change="session-date"]';},closest(){return null;}};
  api.document.dispatch('input',{target:dateEventInput});
  assert.equal(api.getState().sessionDates[key],'2026-03-14','delegated date input saves the selected date');
  dateEventInput.value='';api.document.dispatch('input',{target:dateEventInput});
  assert.equal(api.getState().sessionDates[key],'2026-03-14','delegated empty date input preserves the saved date');

  // The actual delegated day-tab route must use the tab selector, including clicks on a child label.
  const day5=p.exercises.find(r=>r.week===5).day;
  api.setState({...stateBase(),ui:{...stateBase().ui,page:'training',week:5,day:'all'}});
  const dayTab={dataset:{day:day5},closest(sel){return sel==='.day-tab[data-day]'?this:null;}};
  const dayTabChild={dataset:{},closest(sel){return sel==='.day-tab[data-day]'?dayTab:null;}};
  api.document.dispatch('click',{target:dayTabChild});
  assert.equal(api.getState().ui.day,day5,'clicking inside a day tab selects that day');

  // Completing all five real days in Week 5 advances the saved current week exactly once to Week 6.
  api.setState({...stateBase(),settings:{...stateBase().settings,activeWeek:5},ui:{...stateBase().ui,page:'training',week:5,day:'all'},logs:{}});
  const days5=f.uniqueDays(5);
  assert.equal(days5.length,5,'Week 5 has five training days');
  for(const [index,day] of days5.entries()) {
    f.clickAction({dataset:{action:'mark-day',week:'5',day}});
    assert.equal(api.getState().settings.activeWeek,index===4?6:5,'current week advances only when the last day is finished');
  }
  assert.equal(f.currentWeek(),6,'currentWeek follows the completed Week 5 progression');
  assert.equal(JSON.parse(storage.repstate_hypertrophy44_v1).settings.activeWeek,6,'Week 6 persists locally');

  // Sync follows activeWeek on a fresh device but does not interrupt deliberate browsing.
  api.setState({...stateBase(),settings:{...stateBase().settings,activeWeek:5},logs:{'5:x':{sets:[{reps:8,load:1}]}}});const remote=JSON.parse(JSON.stringify(f.syncData()));
  const second=loadApp({});second.setProgram(p);second.setState(stateBase());second.functions.applySyncData(remote);assert.equal(second.functions.currentWeek(),5);assert.equal(second.getState().ui.week,5,'fresh device follows synced activeWeek');
  const browsing=loadApp({});browsing.setProgram(p);browsing.setState({...stateBase(),ui:{...stateBase().ui,week:2}});browsing.functions.applySyncData(remote);assert.equal(browsing.getState().ui.week,2,'sync retains deliberate browsing');

  // Rendered UI uses date text/edit affordance and no Today/Save date controls.
  api.setState({...stateBase(),settings:{...stateBase().settings,activeWeek:1},sessionDates:{[key]:'2026-02-03'}});f.clickAction({dataset:{action:'current-week'}});
  const html=api.app.innerHTML;assert.match(html,/Session date|2026-02-03/i,'UI shows session date');assert.doesNotMatch(html,/>Today<|>Save date</i,'obsolete Today/Save date controls are removed');

  // No remote write occurs if local data changes while a sync GET is in flight.
  let releaseGet; const getReady=new Promise(resolve=>{releaseGet=resolve;}); const calls=[];
  const race=loadApp({},async(url,options)=>{
    if(url==='/program.json') return {ok:false,status:404};
    calls.push(options?.method||'GET');
    if((options?.method||'GET')==='GET') {await getReady;return {ok:true,status:200,json:async()=>({state:{settings:{activeWeek:3},logs:{},checkins:{},sessionDates:{},milestones:{},syncMeta:{}},revision:1})};}
    return {ok:true,status:200,json:async()=>({revision:2})};
  });
  race.setProgram(p);race.setState({...stateBase(),settings:{...stateBase().settings,activeWeek:5}});race.syncInfo.loggedIn=true;
  const pendingSync=race.functions.syncNow();
  race.functions.clickAction({dataset:{action:'mark-day',week:'5',day:days5[0]}});
  releaseGet();await pendingSync;
  assert.deepEqual(calls,['GET'],'local edit during GET must prevent a stale PUT');
  race.syncInfo.loggedIn=false;clearTimeout(race.syncInfo.timer);

  // Focused date editing delays sync until the user leaves the input.
  const focusCalls=[];const focusedApi=loadApp({},async(url)=>{if(url==='/program.json') return {ok:false,status:404};focusCalls.push(url);return {ok:true,status:200,json:async()=>({state:null,revision:1})};});
  focusedApi.setProgram(p);focusedApi.syncInfo.loggedIn=true;
  focusedApi.document.activeElement={matches:sel=>sel==='[data-change=\"session-date\"]'};
  await focusedApi.functions.syncNow();assert.equal(focusCalls.length,0,'focused date input blocks sync');
  focusedApi.syncInfo.loggedIn=false;clearTimeout(focusedApi.syncInfo.timer);

  // Existing previous-set, add/delete/undo flows remain wired to immutable IDs.
  const flow=loadApp({});flow.setProgram(p);flow.setState({...stateBase(),logs:{[row.id]:{sets:[{load:10,reps:8}]}}});
  const next=p.exercises.find(r=>r.week===2&&r.exercise===row.exercise);flow.functions.clickAction({dataset:{action:'copy-last-exercise',id:next.id}});assert.equal(flow.getState().logs[next.id].sets[0].load,10,'copy previous set flow');
  flow.functions.clickAction({dataset:{action:'add-set',id:next.id}});assert(flow.getState().logs[next.id].sets.length>max(flow,next,2),'add flow');
  const extraIndex=flow.getState().logs[next.id].sets.length-1;flow.functions.clickAction({dataset:{action:'delete-set',id:next.id,setIndex:String(extraIndex)}});assert.equal(flow.getState().logs[next.id].sets.length,max(flow,next,2),'delete flow');flow.functions.clickAction({dataset:{action:'undo-delete-set'}});assert.equal(flow.getState().logs[next.id].sets.length,max(flow,next,2)+1,'undo flow');
  console.log('frontend RepState regression tests: PASS');
}
run().catch(e=>{console.error('frontend RepState regression tests: FAIL\n'+e.stack);process.exitCode=1;});
