// Nhãn tiếng Việt + màu Badge cho mức rủi ro và trạng thái file.

import type {RiskLevel} from '../lib/types';
import type {ItemStatus} from '../state';

type BadgeVariant =
  | 'neutral' | 'info' | 'success' | 'warning' | 'error'
  | 'blue' | 'cyan' | 'green' | 'orange' | 'pink' | 'purple' | 'red' | 'teal' | 'yellow';

export const RISK_META: Record<RiskLevel, {label: string; variant: BadgeVariant}> = {
  high: {label: 'Nguy hiểm', variant: 'error'},
  medium: {label: 'Trung bình', variant: 'warning'},
  low: {label: 'Vô hại', variant: 'neutral'},
};

export const RISK_ORDER: RiskLevel[] = ['high', 'medium', 'low'];

export const STATUS_META: Record<ItemStatus, {label: string; variant: BadgeVariant}> = {
  queued: {label: 'Đang chờ', variant: 'neutral'},
  processing: {label: 'Đang xử lý…', variant: 'info'},
  done: {label: 'Đã sạch', variant: 'success'},
  error: {label: 'Lỗi', variant: 'error'},
  unsupported: {label: 'Chưa hỗ trợ', variant: 'warning'},
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
