// Thẻ hiển thị một file trong hàng đợi: trạng thái, điểm riêng tư trước/sau,
// tóm tắt rủi ro, bảng so sánh đã-xoá/còn-giữ và nút tải xuống.

import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {VStack, HStack} from '@astryxdesign/core/Layout';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Text} from '@astryxdesign/core/Text';
import type {QueueItem} from '../state';
import type {MetadataField, RiskLevel} from '../lib/types';
import {canUseFileSystemAccess, downloadBlob, mimeForFormat, saveFileAs} from '../lib/download';
import {InspectorTable} from './InspectorTable';
import {formatBytes, STATUS_META} from './meta';

function riskCounts(item: QueueItem): Record<RiskLevel, number> {
  const counts: Record<RiskLevel, number> = {high: 0, medium: 0, low: 0};
  for (const f of item.report?.fields ?? []) counts[f.risk]++;
  return counts;
}

function scoreVariant(score: number): 'error' | 'warning' | 'success' {
  if (score < 50) return 'error';
  if (score < 85) return 'warning';
  return 'success';
}

/** Câu mô tả tính nguyên vẹn của nội dung, theo loại file. */
function losslessNote(item: QueueItem): string {
  if (item.convertedTo) return '';
  const format = item.report?.format ?? '';
  if (['jpeg', 'png', 'webp', 'gif', 'tiff'].includes(format)) {
    return ' Dữ liệu ảnh giữ nguyên 100% (không nén lại).';
  }
  if (format === 'mp4' || format === 'webm' || format === 'avi') {
    return ' Dữ liệu video giữ nguyên 100% (không re-encode).';
  }
  if (format === 'pdf') return ' Nội dung trang giữ nguyên (file được ghi lại toàn bộ).';
  return ' Nội dung tài liệu giữ nguyên.';
}

/** Trường đã biến mất sau khi làm sạch (so theo id + giá trị). */
function removedFields(item: QueueItem): MetadataField[] {
  const before = item.report?.fields ?? [];
  const after = item.afterReport?.fields ?? [];
  return before.filter(f => !after.some(a => a.id === f.id && a.value === f.value));
}

export function FileCard({
  item,
  downloadName,
  onRemove,
}: {
  item: QueueItem;
  /** Tên file khi tải xuống (đã áp dụng tuỳ chọn đổi tên). */
  downloadName?: string;
  onRemove: (id: number) => void;
}) {
  const status = STATUS_META[item.status];
  const counts = riskCounts(item);
  const report = item.report;
  const fieldCount = report?.fields.length ?? 0;
  const segmentCount = report?.metaSegments.length ?? 0;
  const gone = item.status === 'done' ? removedFields(item) : [];
  const kept = item.afterReport?.fields ?? [];

  const download = () => {
    if (item.cleaned) {
      downloadBlob(
        downloadName ?? item.outputName ?? item.name,
        item.cleaned,
        mimeForFormat(item.convertedTo ?? report?.format),
      );
    }
  };

  const saveTo = () => {
    if (item.cleaned) {
      void saveFileAs(
        downloadName ?? item.outputName ?? item.name,
        item.cleaned,
        mimeForFormat(item.convertedTo ?? report?.format),
      );
    }
  };

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center" gap={3}>
          <VStack gap={0}>
            <Text type="body" weight="bold">
              {item.name}
            </Text>
            <Text type="supporting" color="secondary">
              {formatBytes(item.size)}
              {report?.width ? ` • ${report.width}×${report.height}` : ''}
              {item.formatLabel ? ` • ${item.formatLabel}` : ''}
            </Text>
          </VStack>
          <HStack gap={2} vAlign="center">
            {item.status === 'processing' && <Spinner />}
            {item.status === 'done' &&
              item.scoreBefore !== undefined &&
              item.scoreAfter !== undefined && (
                <HStack gap={1} vAlign="center">
                  <Badge
                    variant={scoreVariant(item.scoreBefore)}
                    label={`Riêng tư ${item.scoreBefore}`}
                  />
                  <Text type="supporting" color="secondary">
                    →
                  </Text>
                  <Badge
                    variant={scoreVariant(item.scoreAfter)}
                    label={`${item.scoreAfter}`}
                  />
                </HStack>
              )}
            <Badge variant={status.variant} label={status.label} />
            {item.status === 'done' && item.cleaned && (
              <>
                {canUseFileSystemAccess() && (
                  <Button label="Lưu vào…" variant="ghost" size="sm" onClick={saveTo} />
                )}
                <Button label="Tải xuống" variant="secondary" size="sm" onClick={download} />
              </>
            )}
            <Button label="Bỏ" variant="ghost" size="sm" onClick={() => onRemove(item.id)} />
          </HStack>
        </HStack>

        {item.status === 'error' && (
          <Banner status="error" title="Không xử lý được file này" description={item.errorMessage} />
        )}
        {item.status === 'unsupported' && (
          <Banner
            status="warning"
            title="Định dạng chưa được hỗ trợ"
            description={
              item.errorMessage ??
              `${item.formatLabel ?? 'Không rõ định dạng'} — xem danh sách hỗ trợ ở cuối trang.`
            }
          />
        )}

        {item.status === 'done' && report && (
          <VStack gap={2}>
            {item.convertedTo && (
              <Banner
                status="info"
                title={`Đã chuyển sang ${item.convertedTo.toUpperCase()}`}
                description={`File gốc không thể xoá metadata tại chỗ. Bản sạch được lưu thành "${item.outputName}".`}
              />
            )}
            {report.trailingBytes > 0 && (
              <Banner
                status="warning"
                title="Phát hiện dữ liệu ẩn sau ảnh"
                description={`${formatBytes(report.trailingBytes)} nằm sau điểm kết thúc ảnh (thường là video "motion photo" hoặc ảnh phụ).`}
              />
            )}

            <HStack gap={2} vAlign="center">
              {counts.high > 0 && <Badge variant="error" label={`${counts.high} nguy hiểm`} />}
              {counts.medium > 0 && <Badge variant="warning" label={`${counts.medium} trung bình`} />}
              {counts.low > 0 && <Badge variant="neutral" label={`${counts.low} vô hại`} />}
              {fieldCount === 0 && segmentCount === 0 && (
                <Text type="supporting" color="secondary">
                  Ảnh vốn đã sạch — không tìm thấy metadata nào.
                </Text>
              )}
            </HStack>

            <Text type="supporting" color="secondary">
              Đã xoá {gone.length > 0 ? `${gone.length} trường metadata` : `${item.removed?.length ?? 0} khối metadata`}
              {item.bytesRemoved ? `, giảm ${formatBytes(item.bytesRemoved)}` : ''}.
              {losslessNote(item)}
              {kept.length > 0
                ? ` Còn giữ theo lựa chọn: ${[...new Set(kept.map(f => f.group))].join(', ')}.`
                : ' Kiểm tra lại sau khi xoá: không còn trường metadata nào.'}
            </Text>

            {(item.notes ?? []).map((note, i) => (
              <Text key={i} type="supporting" color="secondary">
                {note}
              </Text>
            ))}

            {(gone.length > 0 || kept.length > 0) && (
              <Collapsible
                defaultIsOpen={false}
                trigger={
                  <Text type="body">
                    So sánh trước/sau: {gone.length} trường bị xoá
                    {kept.length > 0 ? `, ${kept.length} trường còn giữ` : ''}
                  </Text>
                }
              >
                <VStack gap={3}>
                  {gone.length > 0 && (
                    <VStack gap={1}>
                      <Text type="body" weight="bold">
                        Đã xoá ({gone.length})
                      </Text>
                      <InspectorTable fields={gone} />
                    </VStack>
                  )}
                  {kept.length > 0 && (
                    <VStack gap={1}>
                      <Text type="body" weight="bold">
                        Còn giữ theo lựa chọn ({kept.length})
                      </Text>
                      <InspectorTable fields={kept} />
                    </VStack>
                  )}
                  {segmentCount > 0 && (
                    <Text type="supporting" color="secondary">
                      Khối vật lý trong file gốc:{' '}
                      {report.metaSegments
                        .map(s => `${s.note ?? s.kind}${s.bytes ? ` (${formatBytes(s.bytes)})` : ''}`)
                        .join(', ')}
                    </Text>
                  )}
                </VStack>
              </Collapsible>
            )}
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
