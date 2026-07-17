import {useReducer, useRef, useState} from 'react';
import {Theme} from '@astryxdesign/core/theme';
import {y2kTheme} from '@astryxdesign/theme-y2k/built';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Divider} from '@astryxdesign/core/Divider';
import {FileInput} from '@astryxdesign/core/FileInput';
import {VStack, HStack} from '@astryxdesign/core/Layout';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Text, Heading} from '@astryxdesign/core/Text';
import {detectFormat} from './lib/detect';
import {CleanerError} from './lib/binary';
import {processFile} from './lib/process';
import {canUseFileSystemAccess, downloadBlob, saveAllToDirectory} from './lib/download';
import {buildZip} from './lib/zip';
import {PRESETS, resolvePreset, type PresetId} from './lib/presets';
import type {CleanOptions} from './lib/types';
import {queueReducer, type QueueItem} from './state';
import {FileCard} from './ui/FileCard';
import {formatBytes} from './ui/meta';

const BIG_FILE_WARNING = 200 * 1024 * 1024;

function outputNameFor(name: string, convertedTo?: string): string {
  if (!convertedTo) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${convertedTo}`;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

function randomStem(): string {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return 'file-' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export default function App() {
  const [items, dispatch] = useReducer(queueReducer, []);
  // Đổi key để remount FileInput sau mỗi lần nhận file — ô kéo thả trở về trạng thái trống
  const [dropZoneKey, setDropZoneKey] = useState(0);
  const [preset, setPreset] = useState<PresetId>('social');
  // Đổi tên file khi tải xuống (tên gốc cũng có thể lộ thông tin)
  const [nameMode, setNameMode] = useState<'keep' | 'random' | 'seq'>('keep');
  const randomStems = useRef(new Map<number, string>());
  const [keepIcc, setKeepIcc] = useState(true);
  const [keepOrientation, setKeepOrientation] = useState(true);
  const [keepCopyright, setKeepCopyright] = useState(false);
  const nextId = useRef(1);
  // Ref giữ tuỳ chọn mới nhất để các task đang chạy nền không dùng giá trị cũ
  const optionsRef = useRef<CleanOptions>(resolvePreset('social', {keepIcc: true, keepOrientation: true}));
  optionsRef.current = resolvePreset(preset, {keepIcc, keepOrientation, keepCopyright});

  const activePreset = PRESETS.find(p => p.id === preset)!;

  const runItem = async (item: QueueItem) => {
    dispatch({type: 'update', id: item.id, patch: {status: 'processing'}});
    try {
      // Nhìn 64 byte đầu để nhận diện định dạng — không tin đuôi file
      const head = new Uint8Array(await item.file.slice(0, 64).arrayBuffer());
      const detection = detectFormat(head);
      if (!detection.supported) {
        dispatch({
          type: 'update',
          id: item.id,
          patch: {status: 'unsupported', formatLabel: detection.label},
        });
        return;
      }
      const res = await processFile(item.file, optionsRef.current);
      if (res.ok) {
        dispatch({
          type: 'update',
          id: item.id,
          patch: {
            status: 'done',
            formatLabel: detection.label,
            report: res.report,
            removed: res.removed,
            notes: res.notes,
            bytesRemoved: res.bytesRemoved,
            cleaned: new Uint8Array(res.buffer),
            afterFields: res.afterFields,
            afterReport: res.afterReport,
            scoreBefore: res.scoreBefore,
            scoreAfter: res.scoreAfter,
            convertedTo: res.convertedTo,
            outputName: outputNameFor(item.name, res.convertedTo),
          },
        });
      } else if (res.code === 'unsupported') {
        dispatch({
          type: 'update',
          id: item.id,
          patch: {status: 'unsupported', formatLabel: res.formatLabel, errorMessage: res.message},
        });
      } else {
        dispatch({type: 'update', id: item.id, patch: {status: 'error', errorMessage: res.message}});
      }
    } catch (err) {
      const message =
        err instanceof CleanerError || err instanceof Error ? err.message : String(err);
      dispatch({type: 'update', id: item.id, patch: {status: 'error', errorMessage: message}});
    }
  };

  const addFiles = (files: File | File[] | null) => {
    if (!files) return;
    const list = Array.isArray(files) ? files : [files];
    const newItems: QueueItem[] = list.map(file => ({
      id: nextId.current++,
      file,
      name: file.name,
      size: file.size,
      status: 'queued',
    }));
    dispatch({type: 'add', items: newItems});
    setDropZoneKey(k => k + 1);
    for (const item of newItems) void runItem(item);
  };

  const rerunAll = () => {
    for (const item of items) void runItem(item);
  };

  const doneItems = items.filter(i => i.status === 'done' && i.cleaned);
  const processingCount = items.filter(i => i.status === 'processing' || i.status === 'queued').length;
  const totalSaved = doneItems.reduce((sum, i) => sum + (i.bytesRemoved ?? 0), 0);
  const bigFiles = items.filter(i => i.size > BIG_FILE_WARNING);

  const downloadNameFor = (item: QueueItem): string => {
    const base = item.outputName ?? item.name;
    if (nameMode === 'keep') return base;
    const ext = extOf(base);
    if (nameMode === 'seq') {
      // Đánh số theo VỊ TRÍ trong toàn danh sách (ổn định khi bấm "Bỏ" file khác);
      // ZIP tự khử trùng tên nếu vẫn còn đụng độ
      const idx = items.findIndex(i => i.id === item.id);
      return `file-${String((idx >= 0 ? idx : 0) + 1).padStart(3, '0')}${ext}`;
    }
    let stem = randomStems.current.get(item.id);
    if (!stem) {
      stem = randomStem();
      randomStems.current.set(item.id, stem);
    }
    return stem + ext;
  };

  const removeItem = (id: number): void => {
    randomStems.current.delete(id);
    dispatch({type: 'remove', id});
  };

  const clearAll = (): void => {
    randomStems.current.clear();
    dispatch({type: 'clear'});
  };

  const downloadAllZip = () => {
    if (doneItems.length === 0) return;
    const zip = buildZip(doneItems.map(i => ({name: downloadNameFor(i), data: i.cleaned!})));
    downloadBlob('metawipe-da-lam-sach.zip', zip, 'application/zip');
  };

  const [dirSaveMessage, setDirSaveMessage] = useState('');
  const saveAllToFolder = async () => {
    if (doneItems.length === 0) return;
    try {
      const n = await saveAllToDirectory(
        doneItems.map(i => ({name: downloadNameFor(i), data: i.cleaned!})),
      );
      setDirSaveMessage(n >= 0 ? `Đã lưu ${n} file vào thư mục bạn chọn.` : '');
    } catch {
      setDirSaveMessage('Không lưu được vào thư mục — hãy dùng nút tải ZIP.');
    }
  };

  return (
    <Theme theme={y2kTheme}>
      <main style={{minHeight: '100vh', padding: '1.5rem', display: 'flex', justifyContent: 'center'}}>
        <div style={{width: '100%', maxWidth: 880}}>
          <VStack gap={5}>
            <VStack gap={1}>
              <HStack gap={3} vAlign="center">
                <Heading level={1}>MetaWipe</Heading>
                <Badge variant="success" label="100% trên máy bạn" />
              </HStack>
              <Text type="body" color="secondary">
                Xoá thông tin ẩn trong ảnh — vị trí GPS, tên tác giả, kiểu máy, ngày giờ chụp… —
                trước khi đăng lên mạng. Ảnh <strong>không bao giờ rời khỏi thiết bị</strong>:
                mọi xử lý chạy ngay trong trình duyệt, không gửi đi đâu cả.
              </Text>
            </VStack>

            <Card padding={5}>
              <VStack gap={4}>
                <FileInput
                  key={dropZoneKey}
                  label="Thêm file cần làm sạch"
                  description="Ảnh (JPEG, PNG, WebP, GIF, TIFF, HEIC), video (MP4/MOV, WebM/MKV, AVI), PDF, Word/Excel/PowerPoint — kéo thả nhiều file. Nhận diện bằng nội dung, không tin đuôi file."
                  mode="dropzone"
                  isMultiple
                  placeholder="Kéo thả ảnh vào đây hoặc bấm để chọn"
                  value={null}
                  onChange={addFiles}
                />

                <VStack gap={2}>
                  <SegmentedControl
                    label="Chế độ làm sạch"
                    value={preset}
                    onChange={v => setPreset(v as PresetId)}
                  >
                    {PRESETS.map(p => (
                      <SegmentedControlItem key={p.id} value={p.id} label={p.label} />
                    ))}
                  </SegmentedControl>
                  <Text type="supporting" color="secondary">
                    {activePreset.hint}
                  </Text>
                  {preset === 'custom' && (
                    <HStack gap={4} vAlign="center">
                      <CheckboxInput
                        label="Giữ màu sắc (ICC)"
                        value={keepIcc}
                        onChange={setKeepIcc}
                      />
                      <CheckboxInput
                        label="Giữ hướng xoay"
                        value={keepOrientation}
                        onChange={setKeepOrientation}
                      />
                      <CheckboxInput
                        label="Giữ bản quyền"
                        value={keepCopyright}
                        onChange={setKeepCopyright}
                      />
                    </HStack>
                  )}
                  <HStack gap={3} vAlign="center">
                    <Text type="supporting" color="secondary">
                      Tên file khi tải:
                    </Text>
                    <SegmentedControl
                      label="Đổi tên file khi tải xuống"
                      size="sm"
                      value={nameMode}
                      onChange={v => setNameMode(v as 'keep' | 'random' | 'seq')}
                    >
                      <SegmentedControlItem value="keep" label="Giữ nguyên" />
                      <SegmentedControlItem value="random" label="Ngẫu nhiên" />
                      <SegmentedControlItem value="seq" label="Đánh số" />
                    </SegmentedControl>
                  </HStack>
                  {nameMode !== 'keep' && (
                    <Text type="supporting" color="secondary">
                      Tên file gốc (vd IMG_20260415_HaNoi.jpg) cũng có thể lộ thời gian, địa điểm —
                      file tải xuống sẽ được đặt tên {nameMode === 'random' ? 'ngẫu nhiên' : 'theo số thứ tự'}.
                    </Text>
                  )}
                  {items.length > 0 && (
                    <HStack>
                      <Button
                        label="Xử lý lại tất cả với chế độ hiện tại"
                        variant="ghost"
                        size="sm"
                        isDisabled={processingCount > 0}
                        onClick={rerunAll}
                      />
                    </HStack>
                  )}
                </VStack>
              </VStack>
            </Card>

            {bigFiles.length > 0 && (
              <Text type="supporting" color="secondary">
                Lưu ý: {bigFiles.map(f => f.name).join(', ')} lớn hơn 200 MB — xử lý có thể chậm.
              </Text>
            )}

            {items.length > 0 && (
              <VStack gap={3}>
                {items.map(item => (
                  <FileCard
                    key={item.id}
                    item={item}
                    downloadName={downloadNameFor(item)}
                    onRemove={removeItem}
                  />
                ))}
              </VStack>
            )}

            {items.length > 0 && (
              <Card padding={4}>
                <HStack hAlign="between" vAlign="center" gap={3}>
                  <Text type="body">
                    Đã làm sạch <strong>{doneItems.length}/{items.length}</strong> file
                    {totalSaved > 0 ? ` — nhẹ đi ${formatBytes(totalSaved)}` : ''}
                    {processingCount > 0 ? ` (còn ${processingCount} đang xử lý…)` : ''}
                  </Text>
                  <HStack gap={2}>
                    <Button label="Xoá danh sách" variant="ghost" onClick={clearAll} />
                    {canUseFileSystemAccess() && (
                      <Button
                        label="Lưu vào thư mục…"
                        variant="secondary"
                        isDisabled={doneItems.length === 0}
                        onClick={() => void saveAllToFolder()}
                      />
                    )}
                    <Button
                      label={`Tải tất cả (${doneItems.length} file ZIP)`}
                      variant="primary"
                      isDisabled={doneItems.length === 0}
                      onClick={downloadAllZip}
                    />
                  </HStack>
                </HStack>
                {dirSaveMessage && (
                  <Text type="supporting" color="secondary">
                    {dirSaveMessage}
                  </Text>
                )}
              </Card>
            )}

            <Divider />
            <Text type="supporting" color="secondary">
              Hỗ trợ: ảnh JPEG/PNG/WebP/GIF/TIFF (xoá lossless tại chỗ), HEIC (chuyển sang PNG),
              video MP4/MOV/WebM/MKV/AVI (vô hiệu hoá metadata tại chỗ, không re-encode),
              PDF (ghi lại toàn bộ), Word/Excel/PowerPoint/OpenDocument (làm sạch thuộc tính +
              ẩn danh comment). Cài được như ứng dụng, chạy offline hoàn toàn.
            </Text>
          </VStack>
        </div>
      </main>
    </Theme>
  );
}
