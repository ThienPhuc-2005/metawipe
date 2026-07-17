// Gỡ toạ độ GPS khỏi gói XMP (dùng cho chế độ "chỉ xoá GPS").
// XMP ghi GPS theo 2 dạng: thuộc tính (exif:GPSLatitude="...") và phần tử
// (<exif:GPSLatitude>...</exif:GPSLatitude>) — phải quét cả hai.
//
// Tên tag KHÔNG phân biệt hoa/thường và không chỉ bắt đầu bằng 'GPS':
// drone DJI ghi 'drone-dji:GpsLatitude'/'GpsLongtitude' (sai chính tả của hãng),
// nhiều tool ghi 'Latitude'/'Longitude' trần hoặc 'GeoLocation'.
// Hạn chế đã biết: quét bằng regex nên chuỗi dạng `GPSx="y"` nằm TRONG nội dung
// văn bản (vd mô tả ảnh) cũng có thể bị gỡ — chấp nhận được với tool riêng tư
// (thà xoá nhầm miếng văn bản còn hơn sót toạ độ).

export interface XmpScrubResult {
  xml: string;
  /** Số mục GPS đã gỡ. */
  removed: number;
}

// Tên tag lộ vị trí: gps* (mọi kiểu hoa thường), *latitude/*longitude (kể cả
// 'longtitude' sai chính tả của DJI), altitude, geo*
const GPS_NAME = String.raw`(?:gps\w*|\w*lati?tude|\w*longt?itude|\w*altitude\w*|geo(?!metry)\w*)`;

export function scrubXmpGps(xml: string): XmpScrubResult {
  let removed = 0;

  // Dạng thuộc tính: exif:GPSLatitude="..." / drone-dji:GpsLongtitude='...'
  const attrRe = new RegExp(
    String.raw`\s+(?:[\w-]+:)?${GPS_NAME}\s*=\s*("[^"]*"|'[^']*')`,
    'gi',
  );
  let out = xml.replace(attrRe, () => {
    removed++;
    return '';
  });

  // Dạng phần tử có đóng/mở: <exif:GPSLatitude ...>...</exif:GPSLatitude>
  const elemRe = new RegExp(
    String.raw`<((?:[\w-]+:)?${GPS_NAME})(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>`,
    'gi',
  );
  out = out.replace(elemRe, () => {
    removed++;
    return '';
  });

  // Dạng phần tử tự đóng: <exif:GPSLatitude ... />
  const selfCloseRe = new RegExp(String.raw`<(?:[\w-]+:)?${GPS_NAME}(?:\s[^>]*)?\/>`, 'gi');
  out = out.replace(selfCloseRe, () => {
    removed++;
    return '';
  });

  return {xml: out, removed};
}
