import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import sharp from 'sharp';

const dir = path.join(__dirname, '..', 'postman', 'fixtures');
fs.mkdirSync(dir, { recursive: true });

const noise = (w: number, h: number) =>
  sharp(randomBytes(w * h * 3), { raw: { width: w, height: h, channels: 3 } });

async function main() {
  // JPEG with GPS EXIF. Noise pixels keep it well above 10,485 bytes.
  await noise(640, 480)
    .jpeg({ quality: 90 })
    .withExif({
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '15/1 30/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '32/1 33/1 0/1',
      },
    })
    .toFile(path.join(dir, 'sample_gps.jpg'));

  await noise(64, 64).png().toFile(path.join(dir, 'sample.png'));
  await noise(300, 300).jpeg({ quality: 80 }).toFile(path.join(dir, 'sample2.jpg'));

  fs.writeFileSync(
    path.join(dir, 'sample.pdf'),
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n%%EOF\n',
  );

  fs.writeFileSync(path.join(dir, 'bad.jpg'), 'this is not an image\n');

  fs.writeFileSync(
    path.join(dir, 'fake.mp4'),
    Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(32)]),
  );

  const size = fs.statSync(path.join(dir, 'sample_gps.jpg')).size;
  if (size <= 10_485) throw new Error(`sample_gps.jpg too small (${size}B)`);
  console.log('fixtures written to', dir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});