// Folder holding the porter's shadertoy_*.js files. In the repo, tests/ sits next to them.
// Override with the SB_DIR environment variable.
const path = require('path');
module.exports = process.env.SB_DIR || path.join(__dirname, '..');
