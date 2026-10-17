'use strict';
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

// Browsers only allow microphone access on secure pages. Over a LAN IP that means
// HTTPS, so we keep a self-signed certificate in the data folder. It is
// regenerated when the machine's IP addresses change so the SANs stay correct.
function ensureCert(dataDir, ips) {
  const dir = path.join(dataDir, 'cert');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const metaFile = path.join(dir, 'ips.json');
  const wanted = [...ips].sort().join(',');

  try {
    if (fs.readFileSync(metaFile, 'utf8') === wanted) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    }
  } catch { /* generate below */ }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'LanChat' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(metaFile, wanted);
  return { key: pems.private, cert: pems.cert };
}

module.exports = { ensureCert };
