import type { GitHub } from './github';
import type { DeviceState, ViewRecord } from './types';

const PREFIX = 'device-';
export const deviceFileName = (deviceId: string) => `${PREFIX}${deviceId}.json`;

function newer(a: ViewRecord, b: ViewRecord): ViewRecord {
  const ta = Date.parse(a.at), tb = Date.parse(b.at);
  if (ta !== tb) return ta > tb ? a : b;
  return a.viewed ? b : a;   // 같은 시각이면 해제 기록이 이긴다 (보수적)
}

export function mergeStates(states: DeviceState[]): DeviceState {
  const out: DeviceState = {};
  for (const s of states) for (const [k, v] of Object.entries(s)) out[k] = out[k] ? newer(out[k], v) : v;
  return out;
}

function assertState(name: string, v: unknown): asserts v is DeviceState {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${name}: not an object`);
  for (const [k, r] of Object.entries(v)) {
    const x = r as Partial<Record<keyof ViewRecord, unknown>> | null;
    const ok = typeof x === 'object' && x !== null && typeof x.fp === 'string' &&
      (x.blob === null || typeof x.blob === 'string') && typeof x.head === 'string' &&
      typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)) && typeof x.viewed === 'boolean';
    if (!ok) throw new Error(`${name}: invalid record ${k}`);
  }
}

export async function loadAll(gh: GitHub, gistId: string, deviceId: string) {
  const gist = await gh.getGist(gistId);
  // 파일 목록이 잘리면 내 파일이 없을 수 있고, 빈 상태로 저장하면 기록이 지워진다
  if (gist.truncated) throw new Error('gist file list truncated');
  const states: DeviceState[] = [];
  let own: DeviceState = {};
  for (const [name, file] of Object.entries(gist.files)) {
    if (!name.startsWith(PREFIX) || !name.endsWith('.json')) continue;
    const text = file.truncated ? await gh.fetchRaw(file.raw_url) : file.content;
    const state: unknown = JSON.parse(text);   // 깨진 파일·잘못된 모양은 던진다 — 조용히 버리지 않는다
    assertState(name, state);
    states.push(state);
    if (name === deviceFileName(deviceId)) own = state;
  }
  return { merged: mergeStates(states), own };
}

export function saveOwn(gh: GitHub, gistId: string, deviceId: string, own: DeviceState): Promise<void> {
  return gh.updateGistFile(gistId, deviceFileName(deviceId), JSON.stringify(own));
}
