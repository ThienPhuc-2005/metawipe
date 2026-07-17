// Tải file xuống máy người dùng: qua thẻ <a download> (mọi trình duyệt)
// hoặc File System Access API (Chrome/Edge — lưu thẳng vào thư mục người dùng chọn).

interface FsWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  createWritable(): Promise<FsWritable>;
}
interface FsDirHandle {
  getFileHandle(name: string, opts: {create: boolean}): Promise<FsFileHandle>;
}
interface FsWindow {
  showSaveFilePicker?(opts: {suggestedName?: string}): Promise<FsFileHandle>;
  showDirectoryPicker?(opts?: {mode?: string}): Promise<FsDirHandle>;
}

/** Trình duyệt có hỗ trợ lưu trực tiếp vào file/thư mục không (Chrome/Edge)? */
export function canUseFileSystemAccess(): boolean {
  const w = globalThis as unknown as FsWindow;
  return typeof w.showSaveFilePicker === 'function' && typeof w.showDirectoryPicker === 'function';
}

/** Lưu một file qua hộp thoại "Save as" thật. Trả false nếu người dùng huỷ. */
export async function saveFileAs(name: string, data: Uint8Array, mime: string): Promise<boolean> {
  const w = globalThis as unknown as FsWindow;
  if (!w.showSaveFilePicker) return false;
  try {
    const handle = await w.showSaveFilePicker({suggestedName: name});
    const writable = await handle.createWritable();
    await writable.write(new Blob([data as Uint8Array<ArrayBuffer>], {type: mime}));
    await writable.close();
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false; // người dùng huỷ
    throw err;
  }
}

/** Lưu cả loạt file vào một thư mục người dùng chọn. Trả số file đã ghi (-1 nếu huỷ). */
export async function saveAllToDirectory(
  files: Array<{name: string; data: Uint8Array}>,
): Promise<number> {
  const w = globalThis as unknown as FsWindow;
  if (!w.showDirectoryPicker) return -1;
  let dir: FsDirHandle;
  try {
    dir = await w.showDirectoryPicker({mode: 'readwrite'});
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return -1;
    throw err;
  }
  let written = 0;
  for (const f of files) {
    const handle = await dir.getFileHandle(f.name, {create: true});
    const writable = await handle.createWritable();
    await writable.write(new Blob([f.data as Uint8Array<ArrayBuffer>]));
    await writable.close();
    written++;
  }
  return written;
}

export function downloadBlob(name: string, data: Uint8Array, mime = 'application/octet-stream'): void {
  const blob = new Blob([data as Uint8Array<ArrayBuffer>], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  tiff: 'image/tiff',
  heic: 'image/heic',
  mp4: 'video/mp4',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  office: 'application/zip',
};

export function mimeForFormat(format?: string): string {
  return (format && MIME_BY_FORMAT[format]) || 'application/octet-stream';
}
