import { newId } from '../core/id.js';
import type { FastifyInstance } from 'fastify';
import { frame, log, missions, now, plans, robots, telemetry, geofences } from '../domain/state.js';
import type { Waypoint } from '../domain/types.js';
import { distance, estimatePlan, inFence } from '../services/navigation.js';

export async function registerMissionRoutes(app: FastifyInstance) {
  app.post('/api/missions', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.name || !b.robotId) return res.code(400).send({ error: 'name 和 robotId 必填' });
    const robot = robots.find(x => x.id === b.robotId);
    if (!robot) return res.code(404).send({ error: 'robot not found' });
    const m = {
      id: newId(),
      name: b.name,
      robotId: b.robotId,
      objective: b.objective || 'survey',
      area: b.area || null,
      status: 'draft',
      createdAt: now(),
      riskAcceptance: { maxDepthM: robot.maxDepthM, maxEnergyFraction: .8, ...(b.riskAcceptance || {}) }
    };
    missions.push(m);
    return m;
  });

  app.post('/api/missions/:id/plan', async (req: any, res: any) => {
    const m = missions.find(x => x.id === (req.params as any).id);
    if (!m) return res.code(404).send({ error: 'mission not found' });
    const b = req.body as any;
    if (!Array.isArray(b.waypoints) || b.waypoints.length < 2) return res.code(400).send({ error: '至少需要两个 waypoints' });
    const robot = robots.find(x => x.id === m.robotId)!;
    const estimate = estimatePlan(robot, b.waypoints);
    const p = {
      id: newId(),
      missionId: m.id,
      version: plans.filter(x => x.missionId === m.id).length + 1,
      frame,
      waypoints: b.waypoints,
      estimate,
      turnPolicy: b.turnPolicy || 'terrain-following',
      sonarMode: b.sonarMode || 'side-scan',
      status: estimate.violations.length ? 'blocked' : 'draft',
      createdAt: now()
    };
    plans.push(p);
    m.planId = p.id;
    m.status = 'draft';
    m.approvedBy = null;
    m.approvedAt = null;
    log('mission.plan', p.id, p);
    return p;
  });

  app.post('/api/plans/:id/validate', async (req: any, res: any) => {
    const p = plans.find(x => x.id === (req.params as any).id);
    if (!p) return res.code(404).send({ error: 'plan not found' });
    const mission = missions.find(x => x.id === p.missionId);
    if (!mission) return res.code(404).send({ error: 'mission not found' });
    const robot = robots.find(x => x.id === mission.robotId)!;
    const estimate = estimatePlan(robot, p.waypoints, (req.body as any)?.startPosition || { x: 0, y: 0, z: 0 });
    const failures: any[] = [...estimate.violations];
    const configuredEnergyFraction = Number(mission.riskAcceptance?.maxEnergyFraction);
    const maxEnergyFraction = Number.isFinite(configuredEnergyFraction)
      ? Math.min(1, Math.max(0, configuredEnergyFraction))
      : .8;
    const maxEnergyWh = robot.batteryCapacityWh * maxEnergyFraction;
    if (estimate.energyWh > maxEnergyWh) {
      failures.push({ type: 'energy-budget', energyWh: estimate.energyWh, max: maxEnergyWh, maxEnergyWh, maxEnergyFraction });
    }
    if ((req.body as any)?.minSonarOverlap != null && Number((req.body as any).minSonarOverlap) < .25) {
      failures.push({ type: 'sonar-overlap' });
    }
    p.validation = {
      valid: failures.length === 0,
      failures,
      estimate,
      planId: p.id,
      planVersion: p.version,
      version: p.version,
      missionId: mission.id,
      checkedAt: now()
    };
    p.status = p.validation.valid ? 'validated' : 'blocked';
    return p;
  });

  app.post('/api/missions/:id/approve', async (req: any, res: any) => {
    const m = missions.find(x => x.id === (req.params as any).id);
    if (!m) return res.code(404).send({ error: 'mission not found' });
    const p = plans.find(x => x.id === m.planId);
    if (!p) return res.code(409).send({ error: 'validated plan required' });
    if (!p.validation) return res.code(409).send({ error: `plan version ${p.version} requires validation` });
    if (p.validation.planId !== p.id || p.validation.planVersion !== p.version) {
      return res.code(409).send({ error: `validation for plan version ${p.validation.planVersion} cannot approve version ${p.version}` });
    }
    if (!p.validation.valid) return res.code(409).send({ error: 'validated plan required' });
    if (m.status === 'approved' || m.approvedBy || m.approvedAt) return res.code(409).send({ error: 'mission already approved' });
    m.status = 'approved';
    m.approvedBy = (req.body as any)?.operator || 'mission-director';
    m.approvedAt = now();
    log('mission.approve', m.id, m);
    return m;
  });

  app.post('/api/missions/:id/telemetry', async (req: any, res: any) => {
    const m = missions.find(x => x.id === (req.params as any).id);
    if (!m) return res.code(404).send({ error: 'mission not found' });
    const b = req.body as any;
    if (!b.position || b.timeMs == null || b.batteryWh == null) return res.code(400).send({ error: 'position、timeMs、batteryWh 必填' });
    const t = {
      timeMs: Number(b.timeMs),
      position: b.position,
      headingDeg: Number(b.headingDeg || 0),
      speedMs: Number(b.speedMs || 0),
      batteryWh: Number(b.batteryWh),
      current: b.current || { x: 0, y: 0, z: 0 },
      quality: b.quality || 'good'
    };
    telemetry.push(t);
    const p = plans.find(x => x.id === m.planId);
    const reserve = p?.estimate.returnReserveWh || 3600;
    if (t.batteryWh < reserve) {
      m.status = 'return-required';
      m.reason = 'battery reserve breached';
    }
    if (geofences.some(f => f.restricted && inFence(t.position, f))) {
      m.status = 'safety-hold';
      m.reason = 'restricted zone entered';
    }
    return { accepted: true, telemetry: t, mission: m };
  });

  app.post('/api/missions/:id/replan', async (req: any, res: any) => {
    const m = missions.find(x => x.id === (req.params as any).id);
    if (!m) return res.code(404).send({ error: 'mission not found' });
    const p = plans.find(x => x.id === m.planId);
    if (!p) return res.code(409).send({ error: 'mission has no plan' });
    const b = req.body as any;
    const start = b.startPosition || telemetry.at(-1)?.position || { x: 0, y: 0, z: 0 };
    const remaining = (p.waypoints as Waypoint[]).filter(w => distance(start, w) > 20);
    const robot = robots.find(x => x.id === m.robotId)!;
    const estimate = estimatePlan(robot, remaining, start);
    const replanned = {
      id: newId(),
      missionId: m.id,
      version: plans.filter(x => x.missionId === m.id).length + 1,
      frame,
      waypoints: remaining,
      estimate,
      reason: b.reason || 'dynamic replanning',
      status: estimate.violations.length ? 'blocked' : 'draft',
      createdAt: now()
    };
    plans.push(replanned);
    m.planId = replanned.id;
    m.status = 'draft';
    m.approvedBy = null;
    m.approvedAt = null;
    log('mission.replan', replanned.id, replanned);
    return replanned;
  });

  app.get('/api/missions/:id/dossier', async (req: any, res: any) => {
    const m = missions.find(x => x.id === (req.params as any).id);
    if (!m) return res.code(404).send({ error: 'mission not found' });
    return {
      mission: m,
      plans: plans.filter(x => x.missionId === m.id),
      telemetryCount: telemetry.length,
      pings: [],
      targets: [],
      decision: m.status === 'approved' ? 'ready-to-execute' : m.status
    };
  });
}
