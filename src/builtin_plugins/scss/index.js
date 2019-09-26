const sass = require('node-sass')
const path = require('path')
const fs = require('fs')

exports.constructor = async function (params) {
  return {
    pugFilters: { scss: ScssPugFilter }
  }
}

function ScssPugFilter (text, options) {
  var file = options.filename
  var sassOptions = {}
  if(options.absoluteImport) {
    sassOptions.importer = importer;
  }
  file.endsWith('scss') ? sassOptions.file = file : sassOptions.data = text;
  return sass.renderSync(sassOptions).css.toString('utf8');
}

importer = function(file, prev, done) {
  const absoluteImportPath = path.resolve(path.join(path.dirname(prev), file));
  if(fs.existsSync(absoluteImportPath)) {
      return {file: absoluteImportPath};
  }
};