// Copies the FingerprintJS UMD browser build into public/vendor/ so
// public/track.js can load it from our own server (no third-party CDN call).
const fs = require('fs');
const path = require('path');

const src = path.join(
  __dirname,
  '..',
  'node_modules',
  '@fingerprintjs',
  'fingerprintjs',
  'dist',
  'fp.umd.min.js'
);
const destDir = path.join(__dirname, '..', 'public', 'vendor');
const dest = path.join(destDir, 'fingerprint.min.js');

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest}`);
