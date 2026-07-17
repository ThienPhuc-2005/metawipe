// Cầu nối UI ↔ worker pool: đọc file, chuyển buffer sang worker (zero-copy).

import {WorkerPool, type WorkerLike} from './pool';
import type {CleanOptions} from './types';
import type {CleanRequest, CleanResponse} from '../workers/protocol';

let pool: WorkerPool | null = null;

function getPool(): WorkerPool {
  if (!pool) {
    pool = new WorkerPool(
      () =>
        new Worker(new URL('../workers/clean.worker.ts', import.meta.url), {
          type: 'module',
        }) as unknown as WorkerLike,
    );
  }
  return pool;
}

let nextRequestId = 1;

export async function processFile(file: File, options: CleanOptions): Promise<CleanResponse> {
  const buffer = await file.arrayBuffer();
  const request: CleanRequest = {id: nextRequestId++, name: file.name, buffer, options};
  // Transfer buffer sang worker — không copy, file lớn cũng nhanh
  return getPool().run<CleanResponse>(request, [buffer]);
}
