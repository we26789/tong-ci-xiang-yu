const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run only the game's own trusted pure script, never request content.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script id="game-core">([\s\S]*?)<\/script>/);
if (!script) throw new Error('Missing game-core in index.html');
const sandbox = {window: {}, Date, Math};
vm.runInNewContext(script[1], sandbox, {filename: 'game-core', timeout: 1000});
module.exports = sandbox.window.TCXY;
