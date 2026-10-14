import type { GitHub } from './github';
import type { DeviceState, ViewRecord } from './types';

const PREFIX = 'device-';
export const deviceFileName = (deviceId: string) => `${PREFIX}${deviceId}.json`;

function newer(a: ViewRecord, b: ViewRecord): ViewRecord {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return a.viewed ? b : a;   // 같은 시각이면 해제 기록이 이긴다 (보수적)
}

export function mergeStates(states: DeviceState[]): DeviceState {
  const out: DeviceState = {};
  for (const s of states) for (const [k, v] of Object.entries(s)) out[k] = out[k] ? newer(out[k], v) : v;
  return out;
}

export async function loadAll(gh: GitHub, gistId: string, deviceId: string) {
  const gist = await gh.getGist(gistId);
  const states: DeviceState[] = [];
  let own: DeviceState = {};
  for (const [name, file] of Object.entries(gist.files)) {
    if (!name.startsWith(PREFIX) || !name.endsWith('.json')) continue;
    const text = file.truncated ? await gh.fetchRaw(file.raw_url) : file.content;
    const state = JSON.parse(text) as DeviceState;   // 깨진 파일은 던진다 — 조용히 빈 기록으로 바꾸지 않는다
    states.push(state);
    if (name === deviceFileName(deviceId)) own = state;
  }
  return { merged: mergeStates(states), own };
}

export function saveOwn(gh: GitHub, gistId: string, deviceId: string, own: DeviceState): Promise<void> {
  return gh.updateGistFile(gistId, deviceFileName(deviceId), JSON.stringify(own));
}
