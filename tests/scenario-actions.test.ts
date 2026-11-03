import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h } from 'react';
import { within } from '@testing-library/dom';

test('task scenarios execute panel actions with mock receipts and readable state without Core', async () => {
  // Regression: SCENARIO_READ_ONLY rejected task review/queue POST reads and prevented every panel action in fixtures.
  const window = new Window({url:'http://localhost/?scenario=task-actions'});
  const media = Object.assign(new window.EventTarget(), {matches:true}); window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, {window,document:window.document,location:window.location,HTMLElement:window.HTMLElement,Element:window.Element,
    Node:window.Node,NodeFilter:window.NodeFilter,DocumentFragment:window.DocumentFragment,MutationObserver:window.MutationObserver,
    HTMLInputElement:window.HTMLInputElement,HTMLFormElement:window.HTMLFormElement,Event:window.Event,CustomEvent:window.CustomEvent,CSS:window.CSS,
    localStorage:window.localStorage,ResizeObserver:Observer,matchMedia:window.matchMedia,getComputedStyle:window.getComputedStyle.bind(window),
    innerWidth:1280,innerHeight:800,
    requestAnimationFrame:(callback:FrameRequestCallback)=>setTimeout(()=>callback(performance.now()),0),cancelAnimationFrame:clearTimeout,IS_REACT_ACT_ENVIRONMENT:true});
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('Scenario contacted real Core'); };
  const server = await createServer({configFile:false,server:{middlewareMode:true,watch:null,ws:false}});
  const {createRoot} = await import('react-dom/client'); const mount = document.createElement('div');document.body.append(mount);const root=createRoot(mount);
  try {
    const {installScenario,scenarioResponse} = await server.ssrLoadModule('/ui/scenarios.ts');
    await installScenario('task-actions');
    const { setPrivacy } = await server.ssrLoadModule('/ui/state/privacy.ts');
    setPrivacy(false);
    const call = (op:string,args:Record<string,unknown>) => scenarioResponse('tasks/control','POST',{op,args});
    const timeline = (id:string) => scenarioResponse('agents/conversations/timeline','POST',{agent:'codex',id});
    const id='fixture-task-0';
    const env = scenarioResponse('app/env', 'GET');
    assert.equal(env.active, false); assert.equal(env.clock.source, 'system');
    assert.ok(Number.isFinite(env.clock.value.nowMs));
    const catalog = scenarioResponse('tool-catalog', 'GET');
    assert.ok(catalog.tools.some((tool: any) => tool.name === catalog.required[0]));
    const {default:ToolPolicyField} = await server.ssrLoadModule('/ui/components/ToolPolicyField.tsx');
    const {TooltipProvider} = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const {t} = await server.ssrLoadModule('/ui/i18n.ts');
    await act(async()=>root.render(h(TooltipProvider,null,h(ToolPolicyField,{onChange(){}}))));
    assert.equal(within(mount).getByRole('radio', {name:t('toolsCommon'),exact:true}).getAttribute('aria-checked'), 'true');
    assert.equal(within(mount).queryByRole('alert'), null);
    assert.deepEqual(scenarioResponse('tasks/presence', 'POST', {agent:'codex',taskId:id,present:true}), {present:true});
    const routingArgs = {agent:'codex',taskId:'fixture-task-1',id:'fixture-interaction-1'};
    for (const action of ['read','pause','resume','handoff']) {
      assert.equal(scenarioResponse('tasks/request-routing', 'POST', {...routingArgs,action}).routing.state, 'not-routable');
    }
    assert.deepEqual(scenarioResponse('tasks/reviews','POST',{id}),{reviews:[]});
    assert.deepEqual(call('codex_queue',{threadId:id}).items,[]);
    const {agentActivity} = await server.ssrLoadModule('/ui/state/activity.ts');
    const {default:ActivityTimeline} = await server.ssrLoadModule('/ui/components/ActivityTimeline.tsx');
    await act(async()=>root.render(h(TooltipProvider,null,h(ActivityTimeline,{agent:'codex',session:agentActivity.get().snapshot.agents.codex.sessions[0],expanded:false,onToggleWidth(){},onBack(){}}))));
    const page = within(mount);
    assert.ok(page.getByRole('heading', {name: agentActivity.get().snapshot.agents.codex.sessions[0].title}));
    assert.equal(page.queryByRole('textbox'), null);
    for (const key of ['detail.send', 'detail.stop', 'detail.pass', 'detail.rework']) assert.equal(page.queryByRole('button', {name:t(key),exact:true}), null);
    await act(()=>root.unmount());
    const steered = call('codex_send',{threadId:id,prompt:'Steered fixture input',sendMode:'steer'});
    assert.equal(steered.dispatchMode,'steered');
    assert.ok(timeline(id).entries.some((entry:any)=>entry.type==='user'&&entry.text==='Steered fixture input'));
    await act(async () => { call('codex_send',{threadId:id,prompt:'Queued fixture input',sendMode:'next'}); });
    const queued = call('codex_queue',{threadId:id}).items[0];
    call('codex_queue_control',{threadId:id,queueId:queued.queueId,action:'promote'});
    assert.equal(call('codex_queue',{threadId:id}).items[0].state,'steered');
    assert.ok(timeline(id).entries.some((entry:any)=>entry.type==='user'&&entry.text==='Queued fixture input'));
    call('codex_send',{threadId:id,prompt:'Cancelled fixture input',sendMode:'next'});
    const cancel = call('codex_queue',{threadId:id}).items.find((row:any)=>row.state==='queued');
    call('codex_queue_control',{threadId:id,queueId:cancel.queueId,action:'cancel'});
    assert.equal(call('codex_queue',{threadId:id}).items.find((row:any)=>row.queueId===cancel.queueId).state,'cancelled');
    call('codex_interrupt',{threadId:id,turnId:timeline(id).entries.at(-1).turnId}); assert.equal(timeline(id).status,'cancelled');
    const continuation = call('codex_send',{threadId:id,prompt:'Continue',sendMode:'next'});
    assert.equal(continuation.dispatchMode,'new-turn'); assert.equal(timeline(id).status,'completed');
    assert.equal(call('receipt',{requestId:continuation.requestId}).turnId,continuation.turnId);
    const pass=call('codex_review',{threadId:id,turnId:continuation.turnId,verdict:'pass'});
    assert.equal(call('task_reviews',{id}).reviews[0].review.verdict,'pass');
    call('task_review_undo',{id,turnId:continuation.turnId,reviewRequestId:pass.requestId});
    assert.deepEqual(call('task_reviews',{id}).reviews,[]);
    call('codex_review',{threadId:id,turnId:continuation.turnId,verdict:'rework'});
    assert.equal(call('task_reviews',{id}).reviews[0].review.verdict,'rework');
    for(const skip of [false,true]) {
      await installScenario('task-actions');
      const pending=timeline('fixture-task-1').entries.find((entry:any)=>entry.status==='pending');
      scenarioResponse('agents/respond','POST',{op:'codex_respond',args:{...pending.interaction.respond.args,result:{answers:{choice:{answers:skip?[]:['Alpha']}}}}});
      const saved=timeline('fixture-task-1').entries.find((entry:any)=>entry.id===pending.id);
      assert.equal(saved.response.skipped,skip);assert.equal(saved.response.origin.controlSource,'ARC');assert.equal(saved.status,'completed');
    }
    for(const action of ['approve','bypass','reject']) {
      await installScenario('task-actions');
      const before=scenarioResponse('tasks','GET').records.find((row:any)=>row.state==='awaiting-approval');
      const result=scenarioResponse('tasks/decision','POST',{requestId:before.requestId,action});
      assert.equal(result.state,action==='reject'?'not-executed':'completed');
      assert.equal(scenarioResponse('tasks','GET').records.find((row:any)=>row.requestId===before.requestId).approval.source,'local');
    }
    const {scenarioReadiness} = await server.ssrLoadModule('/ui/state/scenarioReadiness.ts');
    assert.equal(scenarioReadiness(null).state, 'opening');
    assert.throws(()=>scenarioResponse('unknown-write','POST',{}),/SCENARIO_ACTION_UNAVAILABLE/);
    assert.deepEqual(scenarioReadiness(null).missingRoutes, ['POST unknown-write']);
    assert.equal(scenarioReadiness(null).state, 'failed');
    for (const state of ['deferred','paused','routed','not-routable']) {
      await installScenario(`task-routing-${state}`);
      const args = {agent:'codex',taskId:'fixture-task-0',id:'fixture-interaction-0'};
      const route = (action:string) => scenarioResponse('tasks/request-routing','POST',{...args,action}).routing;
      assert.equal(route('read').state, state);
      if (state === 'deferred' || state === 'paused') {
        assert.equal(route('pause').state, 'paused');
        const resumed = route('resume');
        assert.equal(resumed.state, 'deferred'); assert.ok(resumed.deferUntil > Date.now());
        assert.equal(route('handoff').state, 'routed');
      } else {
        assert.equal(route('pause').state, state); assert.equal(route('handoff').state, state);
      }
    }
    await installScenario('timeline-multi-turn');
    assert.deepEqual(scenarioResponse('tasks/reviews','POST',{id}).reviews,[]);
    assert.deepEqual(call('codex_queue',{threadId:id}).items,[]);
  } finally { await act(()=>root.unmount());globalThis.fetch=originalFetch;await server.close();await window.happyDOM.close(); }
});
