const sass = require('node-sass')

exports.constructor = async function (params) {
  return {
    pugFilters: { scss: ScssPugFilter }
  }
}

function ScssPugFilter (text, options) {
  var file = options.filename
  var sassOptions = {}
  file.endsWith('scss') ? sassOptions.file = file : sassOptions.data = text;
  return sass.renderSync(sassOptions).css.toString('utf8');
}