const pug = require('pug')
const fs = require('fs')
const path = require('path')

const VEGA_EXT = '.vegalite.json'
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
        return vegaHtml(text);
      }
    }
  }
}

function vegaHtml(vegaliteSpec) {
  return pug.renderFile(path.join(__dirname, 'template.pug'), {vegaliteSpec});
}

var vegaliteHandler = async function (vegalitePath, page) {
  var vegaliteSpec = fs.readFileSync(vegalitePath, 'utf8')
  var html = vegaHtml(vegaliteSpec)

  await page.setContent(html)
  await page.waitForSelector('#vis')

  var svg = await page.evaluate(function () {
      return document.querySelector('#vis').outerHTML;
  })

  var svgPath = vegalitePath.substr(0, vegalitePath.length - VEGA_EXT.length) + RENDER_EXT
  fs.writeFileSync(svgPath, svg)
}
