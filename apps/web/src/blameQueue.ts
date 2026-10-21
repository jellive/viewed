// 동시 실행 수를 제한하는 작업 대기열 — 순수 모듈(React·DOM 없음).
// skip() 이 참인 대기 작업은 돌리지 않고 skipped(null)로 끝낸다. 비우기는 반복문이라 취소가 수만 개여도 스택이 안 쌓이고,
// 자리는 작업이 끝나든(성공·throw) 건너뛰든 반드시 돌려준다.
export function createQueue(max: number) {
  let running = 0;
  const waiting: { run: (release: () => void) => Promise<void>; skip: () => boolean; done: () => void }[] = [];
  let pumping = false;

  const pump = () => {
    if (pumping) return;
    pumping = true;
    try {
      while (running < max && waiting.length) {
        const w = waiting.shift()!;
        if (w.skip()) { w.done(); continue; }
        running++;
        let freed = false;
        void w.run(() => { if (!freed) { freed = true; running--; } }).finally(() => { pump(); });
      }
    } finally { pumping = false; }
  };

  return {
    running: () => running,
    enqueue<T>(job: () => Promise<T>, skip: () => boolean): Promise<T | null> {
      return new Promise<T | null>((resolve) => {
        waiting.push({
          skip,
          done: () => resolve(null),
          // 자리를 먼저 돌려주고 결과를 내보낸다 — 결과를 받은 쪽이 보는 running 이 이미 줄어 있다
          run: async (release) => { let r: T | null = null; try { r = await job(); } catch { /* null */ } release(); resolve(r); },
        });
        // 마이크로태스크로 미룬다 — 만든 쪽이 refs 를 올린 뒤에 skip() 이 읽혀야 한다
        queueMicrotask(pump);
      });
    },
  };
}
