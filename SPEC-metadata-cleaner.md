# MetaWipe — EXIF/Metadata Cleaner chạy 100% trên trình duyệt

Bản spec này dùng để đưa cho Claude Code. Mục tiêu: một web app tĩnh deploy lên GitHub Pages, xoá metadata khỏi ảnh/video/PDF/tài liệu Office **hoàn toàn phía client** — không có backend, không file nào rời khỏi máy người dùng.

---

## 1. Định vị sản phẩm

- **Privacy-first tuyệt đối**: mọi xử lý diễn ra trong trình duyệt (JS + WASM). Đây vừa là ràng buộc kỹ thuật của GitHub Pages (không có server), vừa là điểm bán hàng lớn nhất — hãy làm nổi bật điều này trên UI ("Files never leave your device").
- **Đối tượng**: người đăng ảnh lên mạng xã hội, nhà báo/nguồn tin, người bán hàng online, dev muốn làm sạch asset.
- **Không cần tài khoản, không analytics theo dõi, hoạt động offline (PWA).**

## 2. Ràng buộc kiến trúc (quan trọng — nói rõ với Claude Code)

- Deploy: **GitHub Pages** → chỉ static files. Không API, không serverless.
- Mọi thư viện nặng (WASM) phải **lazy-load** theo loại file, không tải trước.
- Xử lý file trong **Web Worker** để không đơ UI; batch lớn dùng worker pool.
- Chú ý **COOP/COEP**: nếu dùng ffmpeg.wasm đa luồng cần SharedArrayBuffer, GitHub Pages không cho set header → dùng bản single-thread của ffmpeg.wasm, hoặc dùng trick `coi-serviceworker` để tự inject header qua Service Worker.
- Giới hạn bộ nhớ trình duyệt: file video lớn phải xử lý dạng streaming/chunk nếu có thể, và đặt trần dung lượng hợp lý (ví dụ cảnh báo trên 2GB).

## 3. Phạm vi định dạng & chiến lược xoá

### 3.1 Ảnh
| Định dạng | Metadata cần xoá | Chiến lược |
|---|---|---|
| JPEG | EXIF (APP1), GPS, IPTC (APP13), XMP, thumbnail nhúng, comment | **Strip segment trực tiếp trên bytes** (lossless, không re-encode). Giữ lại tuỳ chọn: ICC profile (APP2), orientation |
| PNG | tEXt/zTXt/iTXt chunks, eXIf chunk, thời gian | Parse chunk, loại bỏ chunk metadata, giữ IHDR/IDAT/PLTE/tRNS |
| WebP | EXIF/XMP chunks trong RIFF | Parse RIFF, bỏ chunk EXIF/XMP |
| TIFF | Toàn bộ IFD tags nhạy cảm | Strip hoặc re-encode |
| HEIC/HEIF | EXIF trong box `meta` | Khó strip tại chỗ → decode bằng libheif WASM rồi re-encode sang JPEG/PNG (ghi rõ cho user là có chuyển đổi) |
| AVIF, GIF | EXIF/XMP box, comment extension | Strip box/extension |

**Nguyên tắc vàng cho ảnh**: ưu tiên thao tác bytes lossless; **chỉ fallback sang canvas re-encode khi bất khả kháng** vì canvas làm giảm chất lượng và mất ICC. Xử lý đúng **EXIF orientation** trước khi xoá — nếu xoá tag orientation mà không xoay pixel, ảnh sẽ hiển thị sai chiều.

### 3.2 Video
| Định dạng | Metadata | Chiến lược |
|---|---|---|
| MP4/MOV | atom `moov/udta`, `©xyz` (GPS của iPhone), `meta`, creation time | Dùng **mp4box.js** để parse/ghi lại atom — nhanh, không re-encode |
| WebM/MKV | EBML tags | Parse EBML, bỏ Tags element |
| Khác (AVI...) | — | Fallback **ffmpeg.wasm** với `-map_metadata -1 -c copy` (remux, không re-encode) |

### 3.3 Tài liệu
| Định dạng | Metadata | Chiến lược |
|---|---|---|
| PDF | Info dictionary (Author, Producer, CreationDate...), XMP metadata stream | **pdf-lib**: set rỗng info dict + xoá XMP |
| DOCX/XLSX/PPTX | `docProps/core.xml`, `docProps/app.xml`, `custom.xml`, comments, revision/tracked changes, tên tác giả trong `document.xml` | Bản chất là file ZIP → dùng **JSZip/fflate**: ghi đè docProps bằng bản rỗng, quét & thay tên tác giả trong XML |
| ODT/ODS | `meta.xml` | Tương tự, thay bằng meta rỗng |

## 4. Tính năng

### Core (MVP)
1. **Drag & drop / chọn nhiều file**, xử lý batch song song qua worker pool.
2. **Metadata Inspector**: hiển thị đầy đủ metadata TRƯỚC khi xoá, phân nhóm và tô mức độ rủi ro:
   - 🔴 Nguy hiểm: GPS (hiện toạ độ + link xem bản đồ), serial number thiết bị, tên tác giả
   - 🟡 Trung bình: model máy ảnh/điện thoại, ngày giờ chụp, phần mềm chỉnh sửa
   - 🟢 Vô hại: kích thước, color space
3. **Xoá chọn lọc**: checkbox theo nhóm — "chỉ xoá GPS", "giữ orientation", "giữ ICC profile", "giữ copyright". Có preset: *Xoá sạch* / *An toàn để đăng mạng xã hội* / *Tuỳ chỉnh*.
4. **So sánh before/after**: bảng diff metadata đã bị loại bỏ, kèm xác nhận kích thước file và chất lượng không đổi (với đường lossless).
5. **Tải xuống**: từng file hoặc **gộp ZIP** cho batch. Tuỳ chọn đổi tên file (tên file gốc cũng có thể lộ thông tin, ví dụ `IMG_20260415_HaNoi.jpg`) → đổi thành tên ngẫu nhiên/tuần tự.
6. **Privacy score**: chấm điểm file trước/sau để gamify ("File này lộ vị trí, thiết bị, và 14 trường khác").

### Nâng cao (phase sau)
- **PWA**: cài đặt được, chạy offline hoàn toàn — rất hợp thông điệp privacy.
- File System Access API (Chrome): ghi đè trực tiếp vào thư mục người dùng chọn.
- Xem vị trí GPS trên bản đồ nhúng (Leaflet + OpenStreetMap tile — lưu ý tile cần mạng; để tuỳ chọn).
- Kéo cả **thư mục** vào để xử lý đệ quy.
- Chế độ "paranoid": tự động re-encode mọi thứ để chắc chắn không sót metadata lạ.

## 5. Tech stack đề xuất

- **Build**: Vite + TypeScript. UI: React (hoặc Preact cho nhẹ) + Tailwind.
- **Đọc metadata**: `exifr` (nhanh, hỗ trợ nhiều định dạng, chạy được trong worker).
- **Xoá JPEG/PNG/WebP**: viết **parser strip-segment thuần TypeScript** (nhỏ, không phụ thuộc, lossless) — đây là phần lõi đáng đầu tư nhất.
- **HEIC**: `libheif-js` (WASM, lazy-load).
- **Video**: `mp4box.js`; fallback `@ffmpeg/ffmpeg` (single-thread, lazy-load, ~25MB WASM — chỉ tải khi cần).
- **PDF**: `pdf-lib`. **Office**: `fflate` hoặc `JSZip`.
- **ZIP output**: `fflate` (nhanh, streaming).
- Không dùng bất kỳ network call nào trong luồng xử lý; CSP chặt (`connect-src 'self'`) để chứng minh.

## 6. Kiến trúc

```
UI (React)
 └─ FileQueue (state máy: queued → inspecting → cleaned → done/error)
     └─ WorkerPool (n = hardwareConcurrency - 1)
         └─ handlers/
             ├─ jpeg.ts   (strip APP segments)
             ├─ png.ts    (strip chunks)
             ├─ webp.ts / heic.ts / tiff.ts
             ├─ mp4.ts    (mp4box)
             ├─ pdf.ts    (pdf-lib)
             ├─ office.ts (zip rewrite)
             └─ fallback-ffmpeg.ts (lazy)
```

- Mỗi handler expose 2 hàm: `inspect(file) → MetadataReport` và `clean(file, options) → Blob`.
- Registry chọn handler theo **magic bytes**, không tin đuôi file.

## 7. Edge cases phải xử lý (đưa vào test)

- JPEG có **nhiều APP1** (EXIF + XMP riêng), XMP extended trải nhiều segment.
- EXIF orientation ≠ 1: xoá tag → phải xoay pixel hoặc giữ lại tag theo lựa chọn user.
- Xoá ICC profile làm ảnh lệch màu → mặc định GIỮ ICC.
- PNG có eXIf chunk (chuẩn mới) chứ không chỉ tEXt.
- MP4 quay bằng iPhone: GPS nằm ở `©xyz` trong `moov/udta` VÀ có thể trong track metadata.
- PDF đã mã hoá → báo lỗi rõ ràng, không crash.
- DOCX có tracked changes/comments chứa tên người → phải quét cả `word/comments.xml`, `people.xml`.
- File 0 byte, file giả mạo đuôi, file cực lớn (cảnh báo bộ nhớ).
- HEIC trên Firefox (không decode native) → bắt buộc đi đường WASM.

## 8. Bộ test

- Chuẩn bị thư mục `test-fixtures/` gồm file mẫu có metadata biết trước (ảnh có GPS giả, DOCX có author...). Có thể sinh bằng exiftool.
- Unit test cho từng handler: sau khi clean, chạy lại `inspect` phải trả về rỗng (hoặc chỉ còn trường được whitelist).
- Test hồi quy: pixel ảnh JPEG sau strip phải **giống hệt byte-for-byte phần SOS/DCT** (chứng minh lossless).

## 9. Lộ trình giao việc cho Claude Code (chia phase để review dễ)

1. **Phase 1**: Scaffold Vite + worker pool + drag&drop + handler JPEG/PNG lossless + inspector UI + download ZIP. → Đây đã là sản phẩm dùng được.
2. **Phase 2**: WebP, TIFF, HEIC (WASM), xoá chọn lọc + preset, privacy score, diff view.
3. **Phase 3**: MP4/MOV (mp4box), PDF, DOCX/XLSX/PPTX, đổi tên file batch.
4. **Phase 4**: ffmpeg.wasm fallback, PWA offline, File System Access API, i18n (VI/EN), polish UI.
5. **Cuối mỗi phase**: chạy test fixtures + deploy GitHub Actions → Pages.

## 10. Deploy

- GitHub Actions: build Vite → publish `dist/` lên Pages. Nhớ set `base` trong `vite.config.ts` đúng tên repo.
- Nếu dùng Service Worker cho PWA/COI: cẩn thận cache-bust khi release.

---

## Prompt khởi động gợi ý (dán vào Claude Code)

> Đọc file SPEC-metadata-cleaner.md. Hãy thực hiện Phase 1: scaffold dự án Vite + TypeScript + React, kiến trúc worker pool như mô tả ở mục 6, viết handler JPEG và PNG strip metadata lossless thuần TypeScript (không dùng canvas), UI drag & drop với metadata inspector phân mức rủi ro, và tải xuống ZIP. Viết test fixtures và unit test cho 2 handler này trước khi làm UI. Ưu tiên đúng đắn (lossless, xử lý edge case ở mục 7) hơn số lượng tính năng.
