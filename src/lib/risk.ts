import type {RiskLevel} from './types';

// Quy tắc phân mức rủi ro theo tên tag. Duyệt theo thứ tự, luật khớp đầu tiên thắng.
// 'high'   = lộ danh tính / vị trí / thiết bị cụ thể
// 'medium' = lộ thói quen, thời gian, thiết bị chung chung
// 'low'    = thông số kỹ thuật vô hại
const RULES: Array<[RegExp, RiskLevel]> = [
  // Phần mềm tạo file — kiểm tra trước vì 'CreatorTool' chứa chữ 'creator'
  [/creator\s?tool|software\s?agent/i, 'medium'],
  [/^gps/i, 'high'],
  [/serial/i, 'high'],
  [/artist|author|creator|by-?line|credit|owner|writer|photographer|person/i, 'high'],
  [/host\s?computer/i, 'high'],
  [/unique\s?id|imageunique|document\s?id|instance\s?id/i, 'high'],
  [/city|country|state|province|location|sub-?location|world\s?region/i, 'high'],
  [/e-?mail|phone|address|contact/i, 'high'],
  // Thông số chụp vô hại — phải đứng TRƯỚC luật date/time vì 'ExposureTime' chứa 'time'
  [/exposure|shutter|aperture|f-?number|iso\b|focal|flash|white\s?balance|metering|brightness|contrast|saturation|sharpness|gain\s?control/i, 'low'],
  [/comment|description|caption|title|subject|keywords|headline|instructions/i, 'medium'],
  [/copyright|rights|source/i, 'medium'],
  [/make$|^make|model|lens|camera|firmware|body/i, 'medium'],
  [/software|processing/i, 'medium'],
  [/date|time/i, 'medium'],
];

export function classifyTag(group: string, tag: string): RiskLevel {
  if (group === 'GPS') return 'high';
  for (const [re, risk] of RULES) {
    if (re.test(tag)) return risk;
  }
  return 'low';
}

import type {MetadataReport} from './types';

/**
 * Điểm riêng tư 0–100: 100 = không lộ gì. Trừ điểm theo mức độ nguy hiểm
 * của những gì tìm thấy — GPS và dữ liệu ẩn sau ảnh bị phạt nặng nhất.
 */
export function privacyScore(report: MetadataReport): number {
  let score = 100;
  const hasGps = report.fields.some(f => f.group === 'GPS');
  if (hasGps) score -= 35;
  for (const f of report.fields) {
    if (f.group === 'GPS') continue; // đã tính gộp ở trên
    if (f.risk === 'high') score -= 12;
    else if (f.risk === 'medium') score -= 4;
    else score -= 0.5;
  }
  if (report.trailingBytes > 0) score -= 25;
  return Math.max(0, Math.round(score));
}

/** Link xem toạ độ trên OpenStreetMap. */
export function osmUrl(lat: number, lon: number): string {
  const la = lat.toFixed(6);
  const lo = lon.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`;
}

/** Đổi toạ độ dạng [độ, phút, giây] + hướng thành số thập phân. */
export function dmsToDecimal(dms: ArrayLike<number>, ref?: string): number | undefined {
  if (!dms || dms.length < 1) return undefined;
  const d = Number(dms[0]) || 0;
  const m = dms.length > 1 ? Number(dms[1]) || 0 : 0;
  const s = dms.length > 2 ? Number(dms[2]) || 0 : 0;
  let v = d + m / 60 + s / 3600;
  if (ref && /^[SW]/i.test(ref.trim())) v = -v;
  return v;
}
