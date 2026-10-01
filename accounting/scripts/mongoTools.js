// Finds a MongoDB Database Tools program (mongodump, mongorestore): MONGO_TOOLS_DIR if set, then
// the PATH, then the default Windows install folder (C:\Program Files\MongoDB\Tools\<version>\bin),
// which the installer does not add to the PATH.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (process.env.MONGO_TOOLS_DIR) {
    const candidate = path.join(process.env.MONGO_TOOLS_DIR, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim().split(/\r?\n/)[0];
  if (process.platform === 'win32') {
    const base = path.join(process.env.ProgramFiles || 'C:\Program Files', 'MongoDB', 'Tools');
    if (fs.existsSync(base)) {
      const versions = fs.readdirSync(base).sort((a, b) => Number(b) - Number(a));
      for (const version of versions) {
        const candidate = path.join(base, version, 'bin', exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

module.exports = { findTool };
