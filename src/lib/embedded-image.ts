// Tóm tắt metadata của MỘT ảnh/tệp nằm bên trong tài liệu (Office, PDF) thành vài trường
// báo cáo: GPS gộp thành một trường nhóm GPS (để điểm riêng tư phạt đúng mức), các
// trường lộ thông tin khác gộp thành một dòng cho mỗi ảnh — liệt kê từng tag của
// hàng chục ảnh sẽ làm ngập bảng so sánh trước/sau.

import type {MetadataField, MetadataReport} from './types';

export interface EmbeddedImageSummary {
  fields: MetadataField[];
  /** Tổng byte các khối metadata (không tính ICC). */
  metaBytes: number;
}

export function summarizeEmbeddedImage(
  report: MetadataReport,
  idPrefix: string,
  name: string,
  group: string,
  kind = 'ảnh nhúng',
): EmbeddedImageSummary {
  const fields: MetadataField[] = [];
  const gps = report.fields.find(f => f.group === 'GPS' && f.mapUrl) ?? report.fields.find(f => f.group === 'GPS');
  if (gps) {
    fields.push({
      id: `${idPrefix}:gps`,
      group: 'GPS',
      tag: `Toạ độ GPS trong ${kind} (${name})`,
      value: gps.mapUrl ? gps.value : 'có',
      risk: 'high',
      mapUrl: gps.mapUrl,
    });
  }
  // ICC là hồ sơ màu chung của thiết bị, giữ theo tuỳ chọn — không tính là lộ thông tin
  const exposed = report.fields.filter(f => f.group !== 'GPS' && f.group !== 'ICC' && f.risk !== 'low');
  const tags = [...new Set(exposed.map(f => f.tag))];
  if (report.trailingBytes > 0) tags.push('dữ liệu ẩn sau ảnh');
  if (tags.length > 0) {
    fields.push({
      id: idPrefix,
      group,
      tag: `Metadata trong ${kind} (${name})`,
      value: `${tags.length} trường: ${tags.slice(0, 8).join(', ')}${tags.length > 8 ? '…' : ''}`,
      risk: exposed.some(f => f.risk === 'high') || report.trailingBytes > 0 ? 'high' : 'medium',
    });
  }
  const metaBytes = report.metaSegments.filter(s => s.kind !== 'icc').reduce((sum, s) => sum + s.bytes, 0);
  return {fields, metaBytes};
}
