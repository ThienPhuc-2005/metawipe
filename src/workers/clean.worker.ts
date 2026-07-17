// Web Worker: nhận file → nhận diện định dạng → đọc metadata → làm sạch →
// tự kiểm tra lại kết quả → gửi về UI. Chạy ngoài luồng chính nên UI không bị đơ.

import {detectFormat} from '../lib/detect';
import {getHandler} from '../lib/handlers';
import {CleanerError} from '../lib/binary';
import {privacyScore} from '../lib/risk';
import type {CleanRequest, CleanResponse} from './protocol';

const ctx = self as unknown as {
  postMessage(message: CleanResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<CleanRequest>) => void) | null;
};

ctx.onmessage = async (ev: MessageEvent<CleanRequest>) => {
  const {id, buffer, options} = ev.data;
  try {
    const bytes = new Uint8Array(buffer);
    const detection = detectFormat(bytes);
    const handler = getHandler(detection.format);
    if (!detection.supported || !handler) {
      ctx.postMessage({
        id,
        ok: false,
        code: 'unsupported',
        message: `Định dạng chưa được hỗ trợ: ${detection.label}.`,
        formatLabel: detection.label,
      });
      return;
    }

    const report = await handler.inspect(bytes);
    const result = await handler.clean(bytes, options);
    // Tự kiểm tra: đọc lại file ĐÃ sạch — nếu chuyển đổi (HEIC→PNG) thì đọc theo định dạng mới
    const afterHandler = result.convertedTo ? (getHandler(result.convertedTo) ?? handler) : handler;
    const after = await afterHandler.inspect(result.data);

    const response: CleanResponse = {
      id,
      ok: true,
      report,
      removed: result.removed,
      notes: result.notes,
      bytesRemoved: result.bytesRemoved,
      buffer: result.data.buffer as ArrayBuffer,
      afterFields: after.fields,
      afterReport: after,
      scoreBefore: privacyScore(report),
      scoreAfter: privacyScore(after),
      convertedTo: result.convertedTo,
    };
    ctx.postMessage(response, [result.data.buffer as ArrayBuffer]);
  } catch (err) {
    if (err instanceof CleanerError) {
      ctx.postMessage({id, ok: false, code: err.code, message: err.message});
    } else {
      ctx.postMessage({
        id,
        ok: false,
        code: 'unknown',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
