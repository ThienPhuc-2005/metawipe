// Các kiểu dữ liệu dùng chung cho toàn bộ phần lõi xử lý metadata.

export type RiskLevel = 'high' | 'medium' | 'low';

/** Một trường metadata đọc được từ file, đã phân mức rủi ro. */
export interface MetadataField {
  id: string;
  /** Nhóm nguồn: EXIF, GPS, XMP, IPTC, ICC, PNG, JPEG... */
  group: string;
  tag: string;
  value: string;
  risk: RiskLevel;
  /** Link mở bản đồ nếu là toạ độ GPS. */
  mapUrl?: string;
}

/** Một "khối chứa" metadata vật lý trong file (segment JPEG / chunk PNG / dữ liệu thừa). */
export interface SegmentInfo {
  /** Mã ổn định để test/UI: 'exif', 'xmp', 'xmp-extended', 'iptc', 'icc', 'mpf',
   *  'comment', 'jfxx', 'app', 'text', 'time', 'xmp-png', 'chunk', 'trailing'... */
  kind: string;
  bytes: number;
  note?: string;
}

export interface MetadataReport {
  format: string;
  fileSize: number;
  width?: number;
  height?: number;
  /** Giá trị tag Orientation của EXIF (1..8) nếu có. */
  orientation?: number;
  fields: MetadataField[];
  /** Các khối metadata vật lý tìm thấy (sẽ bị xoá / xoá tuỳ chọn). */
  metaSegments: SegmentInfo[];
  /** Số byte dữ liệu ẩn nằm SAU điểm kết thúc ảnh (EOI/IEND) — ví dụ video motion photo. */
  trailingBytes: number;
  warnings: string[];
}

export interface CleanOptions {
  /** Giữ ICC profile (màu sắc) — mặc định giữ để ảnh không lệch màu. */
  keepIcc: boolean;
  /** Giữ hướng xoay ảnh (EXIF Orientation) — mặc định giữ để ảnh không xoay sai chiều. */
  keepOrientation: boolean;
  /** Chế độ "chỉ xoá GPS": xoá toạ độ khỏi EXIF/XMP, giữ nguyên metadata khác. */
  gpsOnly?: boolean;
  /** Giữ trường bản quyền (EXIF Copyright) khi xoá sạch. */
  keepCopyright?: boolean;
}

export const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
  keepIcc: true,
  keepOrientation: true,
};

export interface CleanResult {
  data: Uint8Array;
  removed: SegmentInfo[];
  bytesRemoved: number;
  notes: string[];
  /** Đặt khi file bị CHUYỂN ĐỔI định dạng (vd HEIC → PNG) thay vì strip tại chỗ. */
  convertedTo?: string;
}

export interface FormatHandler {
  format: string;
  inspect(bytes: Uint8Array): Promise<MetadataReport>;
  /** Đồng bộ với các định dạng strip tại chỗ; bất đồng bộ với đường chuyển đổi (HEIC). */
  clean(bytes: Uint8Array, options: CleanOptions): CleanResult | Promise<CleanResult>;
}
