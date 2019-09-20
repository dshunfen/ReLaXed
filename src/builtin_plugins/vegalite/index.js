const pug = require('pug')
const fs = require('fs')
const path = require('path')
const vegaembed = require('vega-embed')

const RENDER_EXT = '.svg'

exports.constructor = async function (params) {
  return {
    watchers: [
      {
        extensions: ['.vegalite.json'],
        renderExtension: RENDER_EXT,
        handler: vegaliteHandler
      }
    ],
    pugFilters: {
      vegaLite (text, options) {
        return vegaembed('#vis', text, {'renderer': 'svg'});
      }
    }
  }
}

var vegaliteHandler = async function (vegalitePath, page) {
  var vegaliteSpec = fs.readFileSync(vegalitePath, 'utf8')
  var html = pug.renderFile(path.join(__dirname, 'template.pug'), { vegaliteSpec })

  await page.setContent(html)
  await page.waitForSelector('#vis svg')

  var svg = await page.evaluate(function () {
    var el = document.querySelector('#vis svg')

    el.removeAttribute('height')
    el.removeAttribute('width')

    return el.outerHTML
  })

  var svgPath = vegalitePath.substr(0, vegalitePath.length - '.vegalite.json'.length) + RENDER_EXT
  fs.writeFileSync(svgPath, svg)
}
