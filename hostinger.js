'use strict';
// Entry file for Hostinger Node.js hosting. Hostinger loads the entry file through its own runner, so api/server.js's
// "if (require.main === module)" never fires there and the app never listens. This file always listens. Vercel ignores it.
const http = require('http');
const handler = require('./api/server');

const PORT = process.env.PORT || 3000;
http.createServer(handler).listen(PORT, () => console.log(`cryogen-proxy listening on port ${PORT}`));
