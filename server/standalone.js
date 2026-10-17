'use strict';
// Run the chat server without Electron:  npm run server
const path = require('path');
const { startServer } = require('./index');

startServer({
  port: Number(process.env.PORT) || 3000,
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
}).then((s) => {
  console.log('LanChat running. Open one of:');
  console.log('  ' + s.localUrl);
  for (const u of s.urls()) console.log('  ' + u);
}).catch((e) => { console.error(e); process.exit(1); });
