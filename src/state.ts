// Trạng thái hàng đợi file trên UI: queued → processing → done/error/unsupported

import type {MetadataField, MetadataReport, SegmentInfo} from './lib/types';

export type ItemStatus = 'queued' | 'processing' | 'done' | 'error' | 'unsupported';

export interface QueueItem {
  id: number;
  file: File;
  name: string;
  size: number;
  status: ItemStatus;
  /** Nhãn định dạng thân thiện (vd "JPEG", "WebP (sẽ hỗ trợ ở Phase 2)"). */
  formatLabel?: string;
  report?: MetadataReport;
  removed?: SegmentInfo[];
  notes?: string[];
  bytesRemoved?: number;
  cleaned?: Uint8Array;
  afterFields?: MetadataField[];
  /** Báo cáo đầy đủ của file đã sạch (diff + điểm riêng tư). */
  afterReport?: MetadataReport;
  scoreBefore?: number;
  scoreAfter?: number;
  /** Định dạng mới nếu file bị chuyển đổi (vd HEIC → 'png'). */
  convertedTo?: string;
  /** Tên file khi tải xuống (đổi đuôi nếu chuyển đổi). */
  outputName?: string;
  errorMessage?: string;
}

export type QueueAction =
  | {type: 'add'; items: QueueItem[]}
  | {type: 'update'; id: number; patch: Partial<QueueItem>}
  | {type: 'remove'; id: number}
  | {type: 'clear'};

export function queueReducer(state: QueueItem[], action: QueueAction): QueueItem[] {
  switch (action.type) {
    case 'add':
      return [...state, ...action.items];
    case 'update':
      return state.map(item => (item.id === action.id ? {...item, ...action.patch} : item));
    case 'remove':
      return state.filter(item => item.id !== action.id);
    case 'clear':
      return [];
  }
}
