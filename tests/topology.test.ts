import { arcPath, grownWire, hubMarkGeometry } from "../ui/topology/geometry.ts";
import { TopologyAnimator, nodeKey } from "../ui/topology/animate.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, PARAMETERS, PARAMETER_GROUPS, MIN_HUB_RATIO, distribute, extentOf, solve, LABEL_W, NODE_R, PANEL_ARC_GAP, type Scene } from "../ui/topology/solve.ts";
import { clampParameter, emptyParameters, importParameters, loadParameters, parameterDiff } from "../ui/topology/parameters.ts";

const entities = (prefix: string, counts: number[]) => counts.map((count, i) => ({ id: `${prefix}${i}`,
  tasks: Array.from({ length: count }, (_, j) => ({ id: `${prefix}${i}/task${j}`, width: 232 + j * 18, height: 54 + j * 12 })) }));
// Representative populations for the five lab viewport scenarios. The reference
// solver supplies no serialized scene populations; ids here are synthetic.
const fixtures: Record<string, Scene> = {
  current: { vw: 1000, vh: 640, left: entities("source", [0, 0]), right: entities("agent", [1, 0, 0, 0]) },
  multi: { vw: 1280, vh: 800, left: entities("source", [0, 0]), right: entities("agent", [3, 2, 0, 0]) },
  busy: { vw: 1180, vh: 640, left: entities("source", [0, 0]), right: entities("agent", [5, 4, 3, 0]) },
  bilateral: { vw: 1440, vh: 820, left: entities("source", [2, 3]), right: entities("agent", [3, 2, 0]) },
  narrow: { vw: 900, vh: 680, left: entities("source", [0, 0]), right: entities("agent", [3, 1, 0, 0]) },
};
for (const [name, scene] of Object.entries(fixtures)) test(`topology lab: ${name}`, () => {
  // Property: `topology lab: each population`.
  for (const taskGap of [DEFAULTS.taskGap, PARAMETERS.find(p => p.key === "taskGap")!.min, PARAMETERS.find(p => p.key === "taskGap")!.max]) {
    const parameters = { ...DEFAULTS, taskGap };
    const frozen = JSON.stringify(scene), layout = solve(scene, parameters), [left, right] = layout.wings;
    assert.equal(JSON.stringify(scene), frozen);
    assert.ok(layout.sceneH >= scene.vh);
    assert.equal(layout.hub.y, layout.sceneH / 2);
    for (const wing of layout.wings) {
      assert.equal(wing.nodes.length, (wing.side === -1 ? scene.left : scene.right).length);
      for (let i = 1; i < wing.nodes.length; i++) assert.ok(wing.nodes[i].port - wing.nodes[i - 1].port >= DEFAULTS.earSep - 1e-9);
      for (const node of wing.nodes) {
        if (wing.side === -1) { assert.equal(node.scale, 1); assert.equal(node.opacity, 1); }
        const tasks = wing.tasks.filter(t => t.parent === node.id);
        for (let i = 1; i < tasks.length; i++) {
          assert.equal(tasks[i].y - tasks[i - 1].y, (tasks[i].height + tasks[i - 1].height) / 2 + parameters.taskGap);
          assert.ok(tasks[i].port - tasks[i - 1].port >= 9 - 1e-9);
        }
      }
    }
    for (const wing of layout.wings) {
      const extent = extentOf(wing, layout.hub.x, layout.hub.Re);
      for (const node of [...wing.nodes, ...wing.tasks]) {
        const halfHeight = "size" in node ? node.size * node.scale / 2 : node.height / 2;
        const outerWidth = "size" in node ? LABEL_W * node.scale * node.size / (NODE_R * 2) / 2 : node.width;
        assert.ok(node.y - halfHeight >= DEFAULTS.margin && node.y + halfHeight <= layout.sceneH - DEFAULTS.margin);
        assert.ok(extent.full >= Math.abs(node.x - layout.hub.x) + outerWidth);
      }
    }
    const l = extentOf(left, layout.hub.x, layout.hub.Re), r = extentOf(right, layout.hub.x, layout.hub.Re);
    assert.ok(layout.hub.x - l.full >= DEFAULTS.margin - 1e-9);
    if (l.full + r.full <= scene.vw - 2 * DEFAULTS.margin) assert.ok(layout.hub.x + r.full <= scene.vw - DEFAULTS.margin + 1e-9);
  }
});
test("right-side overflow moves the hub left without compressing or dimming sources", () => {
  // Property: right-side overflow moves the hub left without compressing or dimming sources.
  const empty = { ...fixtures.multi, right: entities("agent", [0, 0, 0, 0]) };
  const idle = solve(empty), busy = solve(fixtures.multi), overflow = solve({ ...fixtures.multi, right: fixtures.busy.right });
  assert.ok(busy.hub.x < idle.hub.x);
  assert.equal(overflow.wings[0].H, idle.wings[0].H);
  assert.deepEqual(overflow.wings[0].nodes.map(n => [n.y - overflow.hub.y, n.scale, n.opacity]),
    idle.wings[0].nodes.map(n => [n.y - idle.hub.y, n.scale, n.opacity]));
  assert.ok(solve(fixtures.busy).sceneH > fixtures.busy.vh);
});
test("asymmetric tasks keep the hub centered while both wings have space", () => {
  // Property: task asymmetry does not displace or compress a scene that fits on both sides of its center.
  for (const counts of [[0, 0], [1, 0], [0, 1], [3, 2], [2, 3]]) {
    const scene = { vw: 2400, vh: 1000, left: entities("source", counts.slice(0, 1)), right: entities("agent", counts.slice(1)) };
    const layout = solve(scene), center = scene.vw / 2;
    assert.ok(layout.balance.every(wing => wing.full <= center - DEFAULTS.margin));
    assert.equal(layout.hub.x, center);
    assert.ok(layout.balance.every(wing => wing.squeeze === 1));
    assert.equal(solve({ ...scene, left: entities("source", [0]), right: entities("agent", [0]) }).hub.x, layout.hub.x);
  }
});

test("edge fitting makes only the displacement needed and recenters when space returns", () => {
  // Property: a fitting scene chooses the nearest feasible point to the viewport center before compressing its columns.
  for (const side of [-1, 1] as const) for (const vw of [1200, 1500, 2000, 2400]) {
    const scene = { vw, vh: 900, left: entities("source", side === -1 ? [2] : [0]), right: entities("agent", side === 1 ? [2] : [0]) };
    const layout = solve(scene), [left, right] = layout.balance;
    assert.ok(left.full + right.full <= vw - 2 * DEFAULTS.margin);
    assert.ok(layout.balance.every(wing => wing.squeeze === 1));
    if (right.full > vw / 2 - DEFAULTS.margin) assert.equal(layout.hub.x + right.full, vw - DEFAULTS.margin);
    else if (left.full > vw / 2 - DEFAULTS.margin) assert.equal(layout.hub.x - left.full, DEFAULTS.margin);
    else assert.equal(layout.hub.x, vw / 2);
    assert.equal(solve({ ...scene, vw: vw * 2 }).hub.x, vw);
  }
});

test("side panels leave the hub centered when their reserved space already fits", () => {
  // Property: either dock may occupy available space without moving a scene that still fits around the viewport center.
  const scene = { ...fixtures.multi, vw: 2400, vh: 900 }, base = solve(scene);
  for (const side of [-1, 1] as const) {
    const selected = side === -1 ? scene.left[0].id : scene.right[0].id;
    const panel = { side, selected, edge: side === 1 ? scene.vw - 416 : 416 };
    const docked = solve({ ...scene, panel });
    assert.equal(docked.hub.x, base.hub.x);
    assert.ok(docked.balance.every(wing => wing.squeeze === 1));
  }
});

test("ring compression precedes balanced columns and respects its lower bound", () => {
  // Property: fitting compresses the ring before equal column ratios, without shrinking the ring below its lower bound.
  let ringCompressed = false, columnsCompressed = false;
  for (let vw = 1600; vw >= 500; vw -= 10) {
    const scene = { ...fixtures.multi, vw }, layout = solve(scene);
    const reference = solve({ ...scene, left: [], right: [] });
    const ratio = layout.hub.Re / reference.hub.Re;
    assert.ok(ratio >= MIN_HUB_RATIO - 1e-9 && ratio <= 1);
    assert.equal(layout.balance[0].squeeze, layout.balance[1].squeeze);
    assert.ok(layout.balance.every(wing => wing.squeeze >= DEFAULTS.squeezeMin));
    if (ratio < 1) ringCompressed = true;
    if (layout.balance[0].squeeze < 1) {
      columnsCompressed = true;
      assert.ok(Math.abs(ratio - MIN_HUB_RATIO) < 1e-9);
    }
  }
  assert.ok(ringCompressed && columnsCompressed);
});
test("hub arc ends maintain clearance from each growing dot", () => {
  // Property: growing either DOT independently shortens both adjacent arcs while retaining equal cap clearance.
  const base = hubMarkGeometry();
  const clearance = (angle: number, scale: number) => 2 * 32 * Math.sin(angle / 2) - 10 * scale;
  for (const scale of [1.1, 1.25]) {
    const source = hubMarkGeometry(scale, 1), agent = hubMarkGeometry(1, scale);
    assert.ok(source.sourceAngle > base.sourceAngle);
    assert.equal(source.agentAngle, base.agentAngle);
    assert.ok(agent.agentAngle > base.agentAngle);
    assert.equal(agent.sourceAngle, base.sourceAngle);
    assert.ok(Math.abs(clearance(source.sourceAngle, scale) - clearance(base.sourceAngle, 1)) < 1e-9);
    assert.equal(source.sourceAngle, agent.agentAngle);
    assert.notEqual(source.top, base.top);
    assert.notEqual(source.bottom, base.bottom);
  }
});
test("wire dimming and availability recover continuously without following scale thresholds", () => {
  // Regression: primary tentacles jumped in opacity when animated scale crossed one during idle/active transitions.
  const scene = { vw: 1600, vh: 220, left: [], right: entities('agent', [0, 1]) };
  const animator = new TopologyAnimator(), key = nodeKey(1, 'agent0');
  const paintNodes = scene.right.map(node => ({ id: node.id, side: 1 as const, state: 'normal' as const, selected: false, attention: false }));
  const target = (tasks: number, inactive = false) => {
    animator.setTargets(solve({ ...scene, right: entities('agent', [tasks, 1]) }));
    animator.appearance(paintNodes.map(n => ({ ...n, state: inactive ? 'inactive' : 'normal' })), []);
  };
  target(0); animator.step(0, true);
  const idle = animator.values(key)!.wireOpacity;
  target(1);
  assert.equal(animator.values(key)!.wireOpacity, idle);
  animator.step(1 / 60);
  const partial = animator.values(key)!.wireOpacity;
  animator.step(0, true);
  const active = animator.values(key)!.wireOpacity;
  assert.ok(partial > idle && partial < active);
  target(0); animator.step(1 / 60);
  assert.ok(animator.values(key)!.wireOpacity > idle && animator.values(key)!.wireOpacity < active);
  target(0, true); animator.step(1 / 60);
  assert.ok(animator.values(key)!.availability > 0 && animator.values(key)!.availability < 1);
  animator.step(0, true);
  assert.equal(animator.values(key)!.availability, 0);
  target(0); animator.step(1 / 60);
  assert.ok(animator.values(key)!.availability > 0 && animator.values(key)!.availability < 1);
  animator.step(0, true);
  assert.equal(animator.values(key)!.availability, 1);
});
test("ports fit the arc and drag is confined to its wing and item", () => {
  // Property: ports fit the arc and drag is confined to its wing and item.
  const { earFollow: follow, earSep: sep, earMax: max } = DEFAULTS;
  for (const raw of [[], [0], [0, 0, 0], [-max, 0, max], [max, 0, -max], Array(30).fill(80)]) {
    const ports = distribute(raw, follow, sep, max);
    assert.equal(ports.length, raw.length);
    assert.ok(ports.every(port => port >= -max - 1e-9 && port <= max + 1e-9));
    for (let i = 1; i < ports.length; i++) {
      assert.ok(ports[i] >= ports[i - 1]);
      if ((ports.length - 1) * sep <= 2 * max) assert.ok(ports[i] - ports[i - 1] >= sep - 1e-9);
    }
  }
  const sc = fixtures.bilateral, base = solve(sc);
  const dragged = solve(sc, DEFAULTS, { kind: "task", side: -1, id: "source0/task0", x: base.wings[0].tasks[0].x, y: 123 });
  assert.equal(dragged.wings[0].tasks[0].y, 123);
  assert.deepEqual(dragged.wings[1], base.wings[1]);
  assert.equal(solve(sc, DEFAULTS, { kind: "node", side: 1, id: "agent0", x: base.wings[1].nodes[0].x, y: 234 }).wings[1].nodes[0].y, 234);
});


test("topology parameters persist only deviations and round-trip through JSON", () => {
  // Property: topology parameters persist only deviations and round-trip through JSON.
  assert.equal(new Set(PARAMETERS.map(p => p.key)).size, PARAMETERS.length);
  for (const spec of PARAMETERS) {
    assert.ok(spec.default >= spec.min && spec.default <= spec.max);
    assert.ok(spec.step > 0);
    assert.ok(PARAMETER_GROUPS[spec.group].en);
    assert.ok("labelKey" in spec ? spec.labelKey : spec.label.en && spec.label["zh-CN"]);
    assert.equal(DEFAULTS[spec.key], spec.default);
  }
  assert.deepEqual(parameterDiff(DEFAULTS), emptyParameters());
  const custom = { ...DEFAULTS, margin: 62, damping: 35 };
  const saved = parameterDiff(custom);
  assert.deepEqual(saved, { schemaVersion: 1, overrides: { margin: 62, damping: 35 } });
  const imported = importParameters(JSON.stringify(saved));
  assert.ok(imported.ok);
  assert.deepEqual(imported.clamped, []);
  assert.deepEqual(loadParameters(imported.document), custom);
  assert.deepEqual(parameterDiff(loadParameters(emptyParameters())), emptyParameters());
});

test("topology parameter ranges clamp at input, save and load boundaries", () => {
  // Property: topology parameter ranges clamp at input, save and load boundaries.
  for (const spec of PARAMETERS) {
    assert.equal(clampParameter(spec.key, spec.min - 1), spec.min);
    assert.equal(clampParameter(spec.key, spec.max + 1), spec.max);
    for (const invalid of [NaN, Infinity, -Infinity]) assert.equal(clampParameter(spec.key, invalid), spec.default);
  }
  const saved = parameterDiff({ ...DEFAULTS, margin: -200, damping: 999, flare: NaN });
  assert.deepEqual(saved.overrides, { margin: PARAMETERS.find(p => p.key === "margin")!.min, damping: PARAMETERS.find(p => p.key === "damping")!.max });
  assert.equal(loadParameters({ schemaVersion: 1, overrides: { margin: 999 } }).margin, PARAMETERS.find(p => p.key === "margin")!.max);
  // Preserve in-range values even when they fall between slider steps.
  assert.equal(clampParameter("colDist", 2.13), 2.13);
});

test("topology imports validate the complete document before applying any values", () => {
  // Property: topology imports validate the complete document before applying any values.
  for (const [json, error] of [
    ["{", "json"], ["null", "schema"], ["[]", "schema"], ["{}", "schema"],
    ['{"schemaVersion":2,"overrides":{}}', "schema"],
    ['{"schemaVersion":1,"overrides":[]}', "schema"],
    ['{"schemaVersion":1,"overrides":{},"extra":true}', "schema"],
    ['{"schemaVersion":1,"overrides":{"unknown":4}}', "key"],
    ['{"schemaVersion":1,"overrides":{"__proto__":4}}', "key"],
    ['{"schemaVersion":1,"overrides":{"margin":"80"}}', "value"],
    ['{"schemaVersion":1,"overrides":{"margin":null}}', "value"],
    ['{"schemaVersion":1,"overrides":{"margin":true}}', "value"],
    ['{"schemaVersion":1,"overrides":{"margin":1e999}}', "value"],
  ]) assert.deepEqual(importParameters(json), { ok: false, error });
  const defaults = Object.freeze({ ...DEFAULTS });
  assert.equal(importParameters('{"schemaVersion":1,"overrides":{"margin":80,"flare":"bad"}}', defaults).ok, false);
  assert.deepEqual(defaults, DEFAULTS);
  const imported = importParameters('{"schemaVersion":1,"overrides":{"margin":999,"earFollow":-1,"colDist":2.6}}');
  assert.ok(imported.ok);
  assert.deepEqual(imported.clamped, ["margin", "earFollow"]);
  assert.deepEqual(imported.document, { schemaVersion: 1, overrides: { margin: PARAMETERS.find(p => p.key === "margin")!.max, earFollow: PARAMETERS.find(p => p.key === "earFollow")!.min } });
});

test("upgraded defaults apply to untouched parameters while manual overrides remain", () => {
  // Property: upgraded defaults apply to untouched parameters while manual overrides remain.
  const saved = parameterDiff({ ...DEFAULTS, damping: 38 });
  const upgraded = { ...DEFAULTS, margin: 54, damping: 30, earFollow: 0.9 };
  const loaded = loadParameters(saved, upgraded);
  assert.equal(loaded.margin, 54);
  assert.equal(loaded.earFollow, 0.9);
  assert.equal(loaded.damping, 38);
  assert.deepEqual(loadParameters(emptyParameters(), upgraded), upgraded);
  const imported = importParameters(JSON.stringify(saved), upgraded);
  assert.ok(imported.ok);
  assert.deepEqual(loadParameters(imported.document, upgraded), loaded);
  assert.deepEqual(parameterDiff({ ...loaded, damping: upgraded.damping }, upgraded), emptyParameters());
});

test("path generation skips non-finite coordinates and recovers on the next frame", () => {
  // Property: path generation skips non-finite coordinates and recovers on the next frame.
  const points = [{ x: 484, y: 348 }, { x: 447.5, y: 348 }, { x: 581.82, y: 348 }, { x: 557, y: 348 }];
  const empty = { outline: "", centerline: "", gap: "" };
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (let i = 0; i < 4; i++) for (const axis of ["x", "y"]) {
      const frame = points.map((p, j) => j === i ? { ...p, [axis]: invalid } : p);
      assert.deepEqual(grownWire(frame[0], frame[1], frame[2], frame[3], 1, 1, true), empty);
    }
    for (let i = 0; i < 5; i++) {
      const args = [450, 340, 130, -30, 30]; args[i] = invalid;
      assert.equal(arcPath(args[0], args[1], args[2], args[3], args[4], 1), "");
    }
    assert.deepEqual(grownWire(points[0], points[1], points[2], points[3], invalid, 1), empty);
  }
  const shape = grownWire(points[0], points[1], points[2], points[3], 1, 1, true);
  assert.ok(shape.centerline && !/NaN|Infinity/.test(shape.centerline));
  assert.ok(shape.outline && !/NaN|Infinity/.test(shape.outline));
});


test("Agent dock reserves its width and label clearance without reordering or moving rows", () => {
  // Property: docking preserves rows and task arcs while giving only the selected idle node a panel attachment.
  for (const vw of [760, 900, 1280, 1800]) {
    const scene = { ...fixtures.busy, vw }, base = solve(scene), edge = vw - 416;
    for (const selected of scene.right.map(n => n.id)) {
      const docked = solve({ ...scene, panel: { side: 1, edge, selected } });
      assert.equal(docked.sceneH, base.sceneH);
      assert.deepEqual(docked.wings.map(w => w.nodes.map(n => [n.id, n.y])), base.wings.map(w => w.nodes.map(n => [n.id, n.y])));
      const node = docked.wings[1].nodes.find(n => n.id === selected)!;
      assert.ok(node.x + LABEL_W * node.scale * node.size / (NODE_R * 2) / 2 <= edge - PANEL_ARC_GAP + 1e-6);
      assert.ok(node.x - node.size * node.scale / 2 >= 0);
      assert.ok(node.scale <= 1);
      for (const n of docked.wings[1].nodes) assert.equal(n.arc !== null, n.active || n.id === selected, n.id);
      assert.ok(docked.wings[1].tasks.every(t => t.hidden));
      assert.ok(docked.balance.every(w => w.squeeze >= DEFAULTS.squeezeMin));
    }
    assert.deepEqual(solve(scene), base, "closing restores the original geometry");
  }
});
test("narrow docks retain arc clearance at minimum width and mirror the left dock", () => {
  // Property: narrow docks retain arc clearance at minimum width and mirror the left dock.
  for (const vw of [360, 600, 759]) for (const side of [-1, 1] as const) {
    const edge = side === 1 ? vw - Math.min(400, vw - 32) - 16 : Math.min(400, vw - 32) + 16;
    const selected = side === 1 ? "agent0" : "source0";
    const layout = solve({ ...fixtures.bilateral, vw, panel: { side, selected, edge, narrow: true } });
    const node = layout.wings.find(w => w.side === side)!.nodes.find(n => n.id === selected)!;
    const radius = node.arc?.R ?? node.size * node.scale / 2 + DEFAULTS.arcGap;
    assert.ok(side === 1 ? node.x + radius <= edge - PANEL_ARC_GAP : node.x - radius >= edge + PANEL_ARC_GAP);
    assert.ok(Number.isFinite(layout.hub.x));
  }
});

test("source dock reserves clearance and keeps Agent bubbles in their original rows", () => {
  // Property: source dock reserves clearance and keeps Agent bubbles in their original rows.
  for (const vw of [760, 900, 1280, 1800]) {
    const scene = { ...fixtures.busy, vw }, base = solve(scene);
    for (const selected of scene.left.map(n => n.id)) {
      const docked = solve({ ...scene, panel: { side: -1, edge: 416, selected } });
      assert.deepEqual(docked.wings.map(w => w.nodes.map(n => [n.id, n.y])), base.wings.map(w => w.nodes.map(n => [n.id, n.y])));
      const node = docked.wings[0].nodes.find(n => n.id === selected)!;
      assert.ok(node.x - LABEL_W * node.scale * node.size / (NODE_R * 2) / 2 >= 416 + PANEL_ARC_GAP - 1e-6);
      assert.ok(docked.wings[1].tasks.every(t => !t.hidden));
      assert.deepEqual(docked.wings[1].tasks.map(t => [t.id, t.y]), base.wings[1].tasks.map(t => [t.id, t.y]));
    }
  }
});

test("hierarchy and activity do not change node size in either orientation", () => {
  // Property: every platform, connector, Agent and profile has the same visual node size.
  const left = [{ id: 'platform', tasks: [], children: entities('connector', [0, 1]) }];
  const right = [{ id: 'agent', tasks: [], children: entities('profile', [0, 1]) }, ...entities('standalone', [0, 2])];
  for (const [vw, vh] of [[1600, 900], [600, 1000]]) {
    const nodes = solve({ vw, vh, left, right }).wings.flatMap(wing => wing.nodes);
    assert.ok(nodes.some(node => node.parent));
    assert.equal(new Set(nodes.map(node => node.size * node.scale)).size, 1);
  }
});
