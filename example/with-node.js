var fs = require('fs')
  , inflate = require('../index')

fs.createReadStream('./index.js.z')
  .pipe(inflate())
  .pipe(process.stdout)
