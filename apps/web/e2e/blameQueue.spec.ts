import { test, expect } from '@playwright/test';
import { createQueue } from '../src/blameQueue';

// 브라우저 없이 도는 순수 큐 테스트 — 취소된 작업이 많아도 스택·자리가 새지 않는다
test('a huge cancelled backlog drains iteratively and frees every slot', async () => {
  const q = createQueue(4);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const blockers = Array.from({ length: 4 }, () => q.enqueue(() => gate.then(() => 'x'), () => false));
  const cancelled = Array.from({ length: 40000 }, () => q.enqueue(async () => 'never', () => true));
  await Promise.resolve();
  release();
  await Promise.all([...blockers, ...cancelled]);
  expect(q.running()).toBe(0);
  expect(await q.enqueue(async () => 'ok', () => false)).toBe('ok');
  expect(q.running()).toBe(0);
});

test('a job that throws resolves as null and frees its slot', async () => {
  const q = createQueue(1);
  expect(await q.enqueue(async () => { throw new Error('boom'); }, () => false)).toBeNull();
  expect(q.running()).toBe(0);
  expect(await q.enqueue(async () => 'ok', () => false)).toBe('ok');
});

test('never runs more than max at once', async () => {
  const q = createQueue(4);
  let cur = 0, max = 0;
  await Promise.all(Array.from({ length: 30 }, () => q.enqueue(async () => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 5)); cur--; return 1; }, () => false)));
  expect(max).toBe(4);
});
