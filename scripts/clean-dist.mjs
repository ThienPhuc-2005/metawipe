// Dọn sạch dist/ trước khi build. Vite có emptyOutDir nhưng trên thư mục OneDrive
// việc xoá có thể thất bại ÂM THẦM do file bị khoá — file build cũ tích tụ làm
// precache của PWA phình lên vô hạn. rmSync với maxRetries xử lý được khoá tạm.
import {rmSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (let attempt = 1; attempt <= 5 && existsSync(dist); attempt++) {
  try {
    rmSync(dist, {recursive: true, force: true, maxRetries: 10, retryDelay: 300});
  } catch {
    // OneDrive/preview server có thể giữ khoá tạm — chờ rồi thử lại
  }
  if (existsSync(dist)) await sleep(700);
}
if (existsSync(dist)) {
  console.error(
    'Không dọn được dist/ — hãy tắt server preview / chờ OneDrive đồng bộ xong rồi build lại. ' +
      'KHÔNG được build đè: file cũ tích tụ sẽ làm hỏng precache của PWA.',
  );
  process.exit(1);
}
console.log('Đã dọn dist/');
