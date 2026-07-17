# MetaWipe — Xoá metadata ảnh, 100% trên máy bạn

Web app xoá thông tin ẩn (EXIF, GPS, tên tác giả, XMP, IPTC…) khỏi ảnh **ngay trong
trình duyệt** — không có máy chủ, ảnh không bao giờ rời khỏi thiết bị.

Đã xong **Phase 1 + 2 + 3** theo [SPEC-metadata-cleaner.md](SPEC-metadata-cleaner.md):
ảnh (JPEG, PNG, WebP, GIF, TIFF lossless; HEIC → PNG), video MP4/MOV (không re-encode),
PDF, Word/Excel/PowerPoint/OpenDocument, và đổi tên file hàng loạt khi tải xuống.

## Chạy thử

```bash
npm install        # lần đầu
npm run dev        # mở http://localhost:5175
```

## Lệnh hay dùng

| Lệnh | Việc |
|---|---|
| `npm run dev` | Chạy app ở chế độ phát triển |
| `npm test` | Chạy toàn bộ unit test (110+ test) |
| `npm run typecheck` | Kiểm tra kiểu TypeScript |
| `npm run build` | Build bản tĩnh vào `dist/` (deploy GitHub Pages được) |
| `npm run fixtures` | Sinh lại file ảnh mẫu vào `test-fixtures/` |

## Mới trong Phase 3

- **Video MP4/MOV**: vô hiệu hoá metadata TẠI CHỖ (đổi box thành `free` + ghi 0)
  — kích thước file giữ nguyên nên offset video không bao giờ xê dịch, an toàn
  tuyệt đối, không re-encode. Xoá: GPS iPhone (©xyz) + vị trí Apple (meta/ilst),
  thời gian quay (mvhd/tkhd/mdhd), tên phần mềm (hdlr, compressorname), XMP (uuid).
- **PDF** (pdf-lib): xoá Info dictionary, luồng XMP (cả object — không sót object
  mồ côi), PieceInfo, tên người trong ghi chú, trailer /ID; PDF có mật khẩu báo
  lỗi tử tế. File được ghi lại toàn bộ, nội dung trang giữ nguyên.
- **Word/Excel/PowerPoint/ODT**: làm rỗng docProps (tác giả, công ty, tổng thời
  gian chỉnh sửa…), xoá custom.xml kèm gỡ tham chiếu, ẩn danh hoá tên người trong
  comment + tracked changes (giữ nội dung góp ý), ODF giữ đúng quy tắc mimetype.
- **Đổi tên file khi tải**: Giữ nguyên / Ngẫu nhiên / Đánh số — vì tên file gốc
  (`IMG_20260415_HaNoi.jpg`) cũng lộ thời gian, địa điểm.

## Mới trong Phase 2

- **WebP**: cắt chunk EXIF/XMP trong RIFF, tự tắt cờ VP8X tương ứng và cập nhật
  RIFF size (đúng chuẩn libwebp mux); giữ ảnh động + alpha + ICC.
- **GIF**: xoá Comment/XMP/extension lạ; giữ timing + vòng lặp của GIF động;
  xử lý cả XMP ghi sai chuẩn (thiếu magic trailer).
- **TIFF**: viết lại toàn bộ file theo danh sách trắng tag hiển thị, copy nguyên
  vẹn dữ liệu ảnh (strip/tile, nhiều trang); từ chối an toàn DNG/BigTIFF.
- **HEIC**: giải mã bằng libheif (WASM, chỉ tải khi cần ~1.4MB) rồi xuất PNG
  sạch — có banner báo chuyển đổi.
- **4 chế độ làm sạch**: An toàn đăng MXH (mặc định) / Xoá sạch tuyệt đối /
  Chỉ xoá vị trí GPS (gỡ GPS khỏi cả EXIF lẫn XMP, giữ nguyên mọi thứ khác) /
  Tuỳ chỉnh (giữ ICC / hướng xoay / bản quyền).
- **Điểm riêng tư 0–100** trước → sau cho từng file.
- **Bảng so sánh trước/sau**: trường nào bị xoá, trường nào còn giữ.

## Đã làm được gì (Phase 1)

- **Kéo thả nhiều file**, xử lý song song bằng worker pool (UI không đơ).
- **Metadata inspector**: liệt kê từng trường, tô mức rủi ro
  (🔴 nguy hiểm: GPS + link xem bản đồ, tên tác giả, số serial máy —
  🟡 trung bình: kiểu máy, ngày giờ, phần mềm — 🟢 vô hại: thông số kỹ thuật).
- **JPEG**: xoá EXIF/GPS, XMP (kể cả XMP mở rộng nhiều segment), IPTC/Photoshop,
  comment, thumbnail JFXX, MPF. Giữ APP14 Adobe (nếu xoá ảnh sẽ sai màu).
- **PNG**: xoá tEXt/zTXt/iTXt/tIME/eXIf/XMP và mọi chunk lạ theo **danh sách trắng**
  (chunk không nhận diện được cũng không lọt lưới); giữ nguyên APNG, màu sắc, trong suốt.
- **Phát hiện & xoá dữ liệu ẩn sau ảnh** (sau EOI/IEND) — nơi giấu video
  "motion photo", ảnh HDR phụ… (nâng cấp so với spec gốc).
- Tuỳ chọn: **giữ ICC profile** (mặc định bật — tránh lệch màu) và **giữ hướng xoay**
  (mặc định bật — dựng lại EXIF tối giản chỉ chứa 1 tag Orientation).
- Nhận diện file bằng **magic bytes**, không tin đuôi file; file rỗng/hỏng/cắt cụt
  báo lỗi rõ ràng, không crash.
- Tải từng file hoặc **gộp ZIP** (tên trùng tự đánh số).
- Sau khi xoá, app **tự đọc lại file sạch để kiểm chứng** và hiển thị kết quả.

## Cấu trúc

```
src/lib/handlers/jpeg.ts   # parser + stripper JPEG (lossless)
src/lib/handlers/png.ts    # parser + stripper PNG (whitelist chunk)
src/lib/handlers/exif.ts   # đọc Orientation, dựng EXIF tối giản
src/lib/pool.ts            # worker pool (n = số nhân CPU - 1, trần 8)
src/workers/clean.worker.ts# chạy detect → inspect → clean → tự kiểm tra
src/ui/                    # giao diện (Astryx design system)
tests/                     # 49 unit test + bộ sinh fixture từng byte
test-fixtures/             # ảnh mẫu có metadata biết trước (npm run fixtures)
```

## Phase tiếp theo (theo spec)

4. PWA offline, ffmpeg.wasm fallback (WebM/AVI), File System Access API, i18n,
   deploy GitHub Pages (cần tạo git repo).
