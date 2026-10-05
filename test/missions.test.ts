import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;

const wp = (x: number, y = 0, z = 10) => ({ x, y, z, dwellSec: 0, speedMs: 1.6 });

async function call(method: string, url: string, body?: any) {
  const res = await app.inject({ method, url, payload: body });
  return { status: res.statusCode, body: res.json() };
}

test.before(async () => {
  app = await buildApp();
});

test.after(async () => {
  await app.close();
});

async function createMission(riskAcceptance?: any) {
  const r = await call('POST', '/api/missions', { name: `T-${Date.now()}-${Math.random()}`, robotId: 'AUV-07', riskAcceptance });
  assert.equal(r.status, 200);
  return r.body;
}

async function plan(missionId: string, waypoints: any[]) {
  const r = await call('POST', `/api/missions/${missionId}/plan`, { waypoints });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test('正常审批：验证结果记录 planId/version，当前版本可通过审批', async () => {
  const m = await createMission();
  const p = await plan(m.id, [wp(0), wp(100)]);

  const v = await call('POST', `/api/plans/${p.id}/validate`);
  assert.equal(v.status, 200);
  assert.equal(v.body.validation.valid, true);
  assert.equal(v.body.validation.planId, p.id);
  assert.equal(v.body.validation.version, 1);
  assert.equal(v.body.status, 'validated');

  const a = await call('POST', `/api/missions/${m.id}/approve`, { operator: 'op-1' });
  assert.equal(a.status, 200);
  assert.equal(a.body.status, 'approved');
  assert.equal(a.body.approvedPlanId, p.id);
  assert.equal(a.body.approvedPlanVersion, 1);
});

test('新建计划后旧验证不可审批，重新验证新版本后方可审批', async () => {
  const m = await createMission();
  const v1 = await plan(m.id, [wp(0), wp(100)]);
  await call('POST', `/api/plans/${v1.id}/validate`);
  const a1 = await call('POST', `/api/missions/${m.id}/approve`);
  assert.equal(a1.status, 200);

  // 创建新版本计划，旧审批失效
  const v2 = await plan(m.id, [wp(0), wp(200)]);
  assert.equal(v2.version, 2);
  const dossier = await call('GET', `/api/missions/${m.id}/dossier`);
  assert.equal(dossier.body.mission.status, 'draft');
  assert.equal(dossier.body.mission.approvedPlanId, null);

  // v2 尚无验证，旧验证挂在 v1 上，不能用于审批
  const stale = await call('POST', `/api/missions/${m.id}/approve`);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentVersion, 2);

  // 重新验证 v2 后审批通过
  const rv = await call('POST', `/api/plans/${v2.id}/validate`);
  assert.equal(rv.body.validation.planId, v2.id);
  assert.equal(rv.body.validation.version, 2);
  const a2 = await call('POST', `/api/missions/${m.id}/approve`);
  assert.equal(a2.status, 200);
  assert.equal(a2.body.status, 'approved');
  assert.equal(a2.body.approvedPlanVersion, 2);
});

test('重规划后旧验证不可审批，重新验证后方可审批', async () => {
  const m = await createMission();
  const v1 = await plan(m.id, [wp(0), wp(300), wp(600), wp(900)]);
  await call('POST', `/api/plans/${v1.id}/validate`);
  const a1 = await call('POST', `/api/missions/${m.id}/approve`);
  assert.equal(a1.status, 200);

  const r = await call('POST', `/api/missions/${m.id}/replan`, { startPosition: { x: 310, y: 0, z: 10 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 2);
  assert.ok(r.body.waypoints.length >= 2, '应保留至少两个未达航点');

  const dossier = await call('GET', `/api/missions/${m.id}/dossier`);
  assert.equal(dossier.body.mission.status, 'draft');

  const stale = await call('POST', `/api/missions/${m.id}/approve`);
  assert.equal(stale.status, 409);

  await call('POST', `/api/plans/${r.body.id}/validate`);
  const a2 = await call('POST', `/api/missions/${m.id}/approve`);
  assert.equal(a2.status, 200);
  assert.equal(a2.body.approvedPlanId, r.body.id);
});

test('能源超限：按任务 maxEnergyFraction 判断而非固定 80%', async () => {
  // 0.001 * 18000Wh = 18Wh，200m 航程约 70Wh，必然超限
  const m = await createMission({ maxDepthM: 1200, maxEnergyFraction: 0.001 });
  const p = await plan(m.id, [wp(0), wp(200)]);

  const v = await call('POST', `/api/plans/${p.id}/validate`);
  assert.equal(v.body.validation.valid, false);
  const energy = v.body.validation.failures.find((f: any) => f.type === 'energy-budget');
  assert.ok(energy, '应报告 energy-budget 失败');
  assert.equal(energy.max, 18);
  assert.equal(energy.maxEnergyFraction, 0.001);
  assert.ok(energy.energyWh > 18);
  assert.equal(v.body.status, 'blocked');

  const a = await call('POST', `/api/missions/${m.id}/approve`);
  assert.equal(a.status, 409);

  // 同一计划在默认 80% 阈值下可以通过，证明阈值取自任务配置
  const m2 = await createMission();
  const p2 = await plan(m2.id, [wp(0), wp(200)]);
  const v2 = await call('POST', `/api/plans/${p2.id}/validate`);
  assert.equal(v2.body.validation.valid, true);
});

test('重复审批：同一计划版本第二次审批被拒绝', async () => {
  const m = await createMission();
  const p = await plan(m.id, [wp(0), wp(100)]);
  await call('POST', `/api/plans/${p.id}/validate`);
  const a1 = await call('POST', `/api/missions/${m.id}/approve`, { operator: 'op-1' });
  assert.equal(a1.status, 200);

  const a2 = await call('POST', `/api/missions/${m.id}/approve`, { operator: 'op-2' });
  assert.equal(a2.status, 409);
  assert.match(a2.body.error, /already approved/);
  // 首次审批信息不被覆盖
  assert.equal(a1.body.approvedBy, 'op-1');
});

test('保留原有检查：深度、禁区、声呐覆盖失败仍阻断审批', async () => {
  const m = await createMission();
  // 深度超限
  const deep = await plan(m.id, [wp(0), wp(100, 0, 1500)]);
  const vd = await call('POST', `/api/plans/${deep.id}/validate`);
  assert.ok(vd.body.validation.failures.some((f: any) => f.type === 'depth-limit'));
  assert.equal(vd.body.validation.valid, false);

  // 禁入区 GF-01: x 600..900, y 300..600, z 200..500
  const fenced = await plan(m.id, [wp(0), wp(700, 400, 300)]);
  const vf = await call('POST', `/api/plans/${fenced.id}/validate`);
  assert.ok(vf.body.validation.failures.some((f: any) => f.type === 'restricted-zone'));
  assert.equal(vf.body.validation.valid, false);

  // 声呐覆盖率不足：最终有效计划上声呐检查与其他检查并存
  const ok = await plan(m.id, [wp(0), wp(100)]);
  const vs = await call('POST', `/api/plans/${ok.id}/validate`, { minSonarOverlap: 0.1 });
  assert.ok(vs.body.validation.failures.some((f: any) => f.type === 'sonar-overlap'));
  assert.equal(vs.body.validation.valid, false);

  const a = await call('POST', `/api/missions/${m.id}/approve`);
  assert.equal(a.status, 409);
});
