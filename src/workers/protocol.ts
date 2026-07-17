// Giao thức nhắn tin giữa UI và worker xử lý file.

import type {CleanerErrorCode} from '../lib/binary';
import type {CleanOptions, MetadataField, MetadataReport, SegmentInfo} from '../lib/types';

export interface CleanRequest {
  id: number;
  name: string;
  buffer: ArrayBuffer;
  options: CleanOptions;
}

export interface CleanSuccess {
  id: number;
  ok: true;
  report: MetadataReport;
  removed: SegmentInfo[];
  notes: string[];
  bytesRemoved: number;
  /** File đã làm sạch. */
  buffer: ArrayBuffer;
  /** Kết quả tự kiểm tra: đọc lại file ĐÃ làm sạch — chỉ còn các trường được cố ý giữ. */
  afterFields: MetadataField[];
  /** Báo cáo đầy đủ của file ĐÃ sạch (phục vụ diff + điểm riêng tư). */
  afterReport: MetadataReport;
  /** Điểm riêng tư 0-100 trước/sau khi làm sạch. */
  scoreBefore: number;
  scoreAfter: number;
  /** Đặt khi file bị chuyển định dạng (vd 'png' cho HEIC→PNG). */
  convertedTo?: string;
}

export interface CleanFailure {
  id: number;
  ok: false;
  code: CleanerErrorCode | 'unknown';
  message: string;
  /** Nhãn định dạng nếu nhận diện được (để báo "chưa hỗ trợ" thân thiện). */
  formatLabel?: string;
}

export type CleanResponse = CleanSuccess | CleanFailure;
