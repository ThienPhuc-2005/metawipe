// Worker pool: chạy nhiều file song song trên nhiều Web Worker để UI không bị đơ.
// Nhận factory tạo worker (để unit test có thể tiêm worker giả).

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: {data: unknown}) => void) | null;
  onerror: ((ev: {message?: string}) => void) | null;
}

interface Task {
  msg: unknown;
  transfer: Transferable[];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export function defaultPoolSize(): number {
  const hc =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  // Theo spec: số worker = số nhân CPU - 1; chặn trần 8 để máy nhiều nhân
  // không phải khởi tạo hàng chục worker (mỗi worker đều tốn RAM) vô ích.
  return Math.min(Math.max(1, hc - 1), 8);
}

export class WorkerPool {
  private idle: WorkerLike[] = [];
  private queue: Task[] = [];
  private busy = new Map<WorkerLike, Task>();
  private spawned = 0;
  private destroyed = false;
  // Đánh dấu worker đã bị huỷ: chống trừ trùng `spawned` khi onerror bắn 2 lần
  private droppedWorkers = new WeakSet<WorkerLike>();

  constructor(
    private factory: () => WorkerLike,
    private size: number = defaultPoolSize(),
  ) {
    if (size < 1) throw new Error('Kích thước pool phải >= 1');
  }

  run<T>(msg: unknown, transfer: Transferable[] = []): Promise<T> {
    if (this.destroyed) return Promise.reject(new Error('Pool đã bị huỷ.'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({msg, transfer, resolve: resolve as (v: unknown) => void, reject});
      this.pump();
    });
  }

  /** Số task đang chạy — phục vụ test và hiển thị tiến độ. */
  get activeCount(): number {
    return this.busy.size;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private pump(): void {
    while (this.queue.length > 0 && !this.destroyed) {
      let worker = this.idle.pop();
      if (!worker) {
        if (this.spawned >= this.size) return;
        worker = this.spawn();
      }
      const task = this.queue.shift()!;
      this.busy.set(worker, task);
      try {
        worker.postMessage(task.msg, task.transfer);
      } catch (err) {
        this.busy.delete(worker);
        this.dropWorker(worker);
        task.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private spawn(): WorkerLike {
    const worker = this.factory();
    this.spawned++;
    worker.onmessage = ev => {
      const task = this.busy.get(worker);
      this.busy.delete(worker);
      if (!this.destroyed) this.idle.push(worker);
      task?.resolve(ev.data);
      this.pump();
    };
    worker.onerror = ev => {
      const task = this.busy.get(worker);
      this.busy.delete(worker);
      this.dropWorker(worker);
      task?.reject(new Error(`Worker gặp lỗi: ${ev?.message ?? 'không rõ nguyên nhân'}`));
      this.pump();
    };
    return worker;
  }

  private dropWorker(worker: WorkerLike): void {
    if (this.droppedWorkers.has(worker)) return;
    this.droppedWorkers.add(worker);
    // Worker chết trong lúc đang rảnh vẫn nằm trong hàng idle — phải gỡ ra,
    // nếu không pump() sẽ giao task cho xác chết (postMessage sau terminate bị
    // nuốt im lặng theo chuẩn Worker) và task treo vĩnh viễn
    this.idle = this.idle.filter(w => w !== worker);
    this.spawned--;
    try {
      worker.terminate();
    } catch {
      // bỏ qua lỗi khi huỷ worker
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const w of this.idle) this.dropWorker(w);
    this.idle = [];
    for (const [w, task] of this.busy) {
      task.reject(new Error('Pool đã bị huỷ.'));
      this.dropWorker(w);
    }
    this.busy.clear();
    for (const task of this.queue) task.reject(new Error('Pool đã bị huỷ.'));
    this.queue = [];
  }
}
