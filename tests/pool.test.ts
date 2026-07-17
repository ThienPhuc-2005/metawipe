// Test worker pool với worker giả (không cần Web Worker thật trong Node).

import {describe, expect, it} from 'vitest';
import {WorkerPool, type WorkerLike} from '../src/lib/pool';

interface FakeControls {
  maxConcurrent: () => number;
  spawnCount: () => number;
}

function makeFakeFactory(opts?: {failWhen?: (msg: unknown) => boolean}): {
  factory: () => WorkerLike;
  controls: FakeControls;
} {
  let active = 0;
  let maxActive = 0;
  let spawned = 0;

  const factory = (): WorkerLike => {
    spawned++;
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg: unknown) {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active--;
          if (opts?.failWhen?.(msg)) {
            worker.onerror?.({message: 'worker giả nổ theo kịch bản'});
          } else {
            worker.onmessage?.({data: {echo: msg}});
          }
        }, 1);
      },
      terminate() {
        // không cần làm gì với worker giả
      },
    };
    return worker;
  };

  return {
    factory,
    controls: {maxConcurrent: () => maxActive, spawnCount: () => spawned},
  };
}

describe('WorkerPool', () => {
  it('chạy hết 20 task và trả kết quả đúng thứ tự promise', async () => {
    const {factory} = makeFakeFactory();
    const pool = new WorkerPool(factory, 3);
    const results = await Promise.all(
      Array.from({length: 20}, (_, i) => pool.run<{echo: number}>(i)),
    );
    results.forEach((r, i) => expect(r.echo).toBe(i));
    pool.destroy();
  });

  it('không bao giờ chạy quá số worker cho phép, không tạo thừa worker', async () => {
    const {factory, controls} = makeFakeFactory();
    const pool = new WorkerPool(factory, 3);
    await Promise.all(Array.from({length: 15}, (_, i) => pool.run(i)));
    expect(controls.maxConcurrent()).toBeLessThanOrEqual(3);
    expect(controls.spawnCount()).toBeLessThanOrEqual(3);
    pool.destroy();
  });

  it('một task lỗi chỉ làm task đó fail — các task khác vẫn xong', async () => {
    const {factory} = makeFakeFactory({failWhen: msg => msg === 7});
    const pool = new WorkerPool(factory, 2);
    const results = await Promise.allSettled(
      Array.from({length: 12}, (_, i) => pool.run(i)),
    );
    expect(results[7].status).toBe('rejected');
    results.forEach((r, i) => {
      if (i !== 7) expect(r.status).toBe('fulfilled');
    });
    // Pool vẫn dùng được tiếp sau khi một worker chết
    const more = await pool.run<{echo: string}>('van chay tot');
    expect(more.echo).toBe('van chay tot');
    pool.destroy();
  });

  it('worker chết LÚC ĐANG RẢNH không làm treo task kế tiếp (xác chết phải bị gỡ khỏi hàng idle)', async () => {
    // Worker giả đúng ngữ nghĩa Web Worker thật: postMessage sau terminate() bị nuốt im lặng
    const instances: Array<WorkerLike & {dead: boolean}> = [];
    const factory = (): WorkerLike => {
      const worker: WorkerLike & {dead: boolean} = {
        dead: false,
        onmessage: null,
        onerror: null,
        postMessage(msg: unknown) {
          if (worker.dead) return; // xác chết nuốt message — không lỗi, không kết quả
          setTimeout(() => worker.onmessage?.({data: {echo: msg}}), 1);
        },
        terminate() {
          worker.dead = true;
        },
      };
      instances.push(worker);
      return worker;
    };

    const pool = new WorkerPool(factory, 1);
    const first = await pool.run<{echo: number}>(1);
    expect(first.echo).toBe(1);

    // Worker đang rảnh (nằm trong idle) thì bắn lỗi → pool phải loại nó ra
    instances[0].onerror?.({message: 'chết lúc rảnh'});
    const second = await pool.run<{echo: number}>(2); // nếu pool giao task cho xác chết, test sẽ treo → timeout
    expect(second.echo).toBe(2);
    expect(instances.length).toBe(2); // đã tạo worker mới thay thế

    // Bắn lỗi trùng lần nữa vào worker đã chết: sổ sách không được âm/loạn
    instances[0].onerror?.({message: 'lỗi trùng'});
    const third = await pool.run<{echo: number}>(3);
    expect(third.echo).toBe(3);
    pool.destroy();
  });

  it('destroy() từ chối các task đang chờ', async () => {
    const {factory} = makeFakeFactory();
    const pool = new WorkerPool(factory, 1);
    const first = pool.run(1);
    const pending = pool.run(2);
    pool.destroy();
    await expect(pending).rejects.toThrow('huỷ');
    await first.catch(() => undefined); // task đang chạy cũng bị huỷ — không được treo
  });
});
