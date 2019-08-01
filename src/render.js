const pug = require('pug')
const colors = require('colors/safe')
const cheerio = require('cheerio')
const puppeteer = require('puppeteer')
const fs = require('fs')
const fg = require('fast-glob')
const filesize = require('filesize')
const path = require('path')
const { performance } = require('perf_hooks')
const { inlineSource } = require('inline-source')

fileToPdf = async function (masterPath, relaxedGlobals, tempHTMLPath, outputPath, locals) {
  var timings = {t0: performance.now()}

  var html = await generateHtmlFromPath(masterPath, relaxedGlobals, locals)
  html = await inlineTheThings(relaxedGlobals, 'reportId', html)

  timings.tHTML = performance.now()
  console.log(colors.magenta(`... HTML generated in ${((timings.tHTML - timings.t0) / 1000).toFixed(1)}s`))

  fs.writeFileSync(tempHTMLPath, html)

  await renderPdf(relaxedGlobals, tempHTMLPath, outputPath, html, timings)
}

browseToPage = async function browseToPage(puppeteerConfig, relaxedGlobals) {
  const browser = await puppeteer.launch(puppeteerConfig);
  relaxedGlobals.puppeteerPage = await browser.newPage();

  relaxedGlobals.puppeteerPage.on('pageerror', function(err) {
    console.log(colors.red('Page error: ' + err.toString()));
  }).on('error', function(err) {
    console.log(colors.red('Error: ' + err.toString()));
  });
}

contentToHtml = async function contentToHtml(masterPug, reportName, relaxedGlobals) {
  var timings = {t0: performance.now()}

  var html = await generateHtmlFromContent(masterPug, reportName, relaxedGlobals, {})
  html = await inlineTheThings(relaxedGlobals, reportName, html)

  timings.tHTML = performance.now()
  console.log(colors.magenta(`... HTML generated in ${((timings.tHTML - timings.t0) / 1000).toFixed(1)}s`))

  return html;

}

renderDependencies = async function renderDependencies(p, pluginExtensionMapping) {
  let extensions = Object.keys(pluginExtensionMapping).map(key => path.join(p, '**','*' + key));
  const stream = fg.stream(extensions, { dot: true });
  let notifiedOfDependencies = false;

  for await (const sourceFile of stream) {
    let sourceExt = path.extname(sourceFile);
      if (sourceExt in pluginExtensionMapping) {
        let renderedFile = sourceFile.substr(0, sourceFile.length - sourceExt.length) + pluginExtensionMapping[sourceExt];
        if (!fs.existsSync(renderedFile)) {
          if(!notifiedOfDependencies) {
            console.log(colors.magenta.bold('\nRendering dependencies...'))
            notifiedOfDependencies = true;
          }
          await build(sourceFile);
        }
      }
  }
}

// Wait for all the content on the page to finish loading
function waitForNetworkIdle (page, timeout, maxInflightRequests = 0) {
  page.on('request', onRequestStarted)
  page.on('requestfinished', onRequestFinished)
  page.on('requestfailed', onRequestFinished)

  let inflight = 0
  let fulfill
  let promise = new Promise(x => fulfill = x)
  let timeoutId = setTimeout(onTimeoutDone, timeout)
  return promise

  function onTimeoutDone () {
    page.removeListener('request', onRequestStarted)
    page.removeListener('requestfinished', onRequestFinished)
    page.removeListener('requestfailed', onRequestFinished)
    fulfill()
  }

  function onRequestStarted () {
    ++inflight
    if (inflight > maxInflightRequests) {
      clearTimeout(timeoutId)
    }
  }

  function onRequestFinished () {
    if (inflight === 0) {
      return
    }
    --inflight
    if (inflight === maxInflightRequests) {
      timeoutId = setTimeout(onTimeoutDone, timeout)
    }
  }
}

async function generateHtml(pluginHooks, masterPug, locals, masterPath) {
  var pluginPugHeaders = [];
  for (var pugHeader of pluginHooks.pugHeaders) {
    pluginPugHeaders.push(pugHeader.instance);
  }
  pluginPugHeaders = pluginPugHeaders.join('\n\n');

  var pugFilters = Object.assign(...pluginHooks.pugFilters.map(o => o.instance));

  var html = pug.render(pluginPugHeaders + '\n' + masterPug, Object.assign({}, locals ? locals : {}, {
    filename: path.join(masterPath, 'file.stuff'),
    fs: fs,
    basedir: masterPath,
    cheerio: cheerio,
    __root__: path.dirname(masterPath),
    path: path,
    require: require,
    performance: performance,
    filters: pugFilters
  }));

  /*
   *            MODIFY HTML
   */
  var head = pluginHooks.headElements.map(e => e.instance).join(`\n\n`)
  html = `
    <html>
      <head>
        <meta charset="UTF-8">
        ${head}
      </head>
      <body> ${html} </body>
    </html>`

  for (var htmlModifier of pluginHooks.htmlModifiers) {
    html = await htmlModifier.instance(html)
  }

  return html
}

async function generateHtmlFromContent(masterPug, reportId, relaxedGlobals, {}) {
  var pluginHooks = relaxedGlobals.pluginHooks
  return generateHtml(pluginHooks, masterPug, {}, path.join(relaxedGlobals.basedir, reportId), relaxedGlobals);
}

async function generateHtmlFromPath(masterPath, relaxedGlobals, locals) {
  var pluginHooks = relaxedGlobals.pluginHooks
  var html
  if (masterPath.endsWith('.pug')) {
    var masterPug = fs.readFileSync(masterPath, 'utf8')
    html = generateHtml(pluginHooks, masterPug, locals, masterPath, relaxedGlobals);
  } else if (masterPath.endsWith('.html')) {
    html = fs.readFileSync(masterPath, 'utf8')
  }

  return html;
}

async function inlineTheThings(relaxedGlobals, reportId, html) {
   /*
   *            INLINE THE THINGS
   */
  try {

    html = await inlineSource(html, {
      compress: true,
      rootpath: path.resolve(relaxedGlobals.basedir, reportId),
      svgAsImg: true,
    });
  } catch (err) {
    console.error(err)
  }
  return html;
}

async function renderPdf(relaxedGlobals, tempHTMLPath, outputPath, html, timings) {
  var pluginHooks = relaxedGlobals.pluginHooks
  var page = relaxedGlobals.puppeteerPage
  /*
   *            LOAD HTML
   */
  try {
    await page.goto('file:' + tempHTMLPath, {
      waitUntil: ['load', 'domcontentloaded'],
      timeout: 1000 * (relaxedGlobals.config.pageRenderingTimeout || 30)
    })
  } catch(error) {
    console.log(error.message)
    console.error(colors.red('There was a page loading error.'))
    if (error.message.indexOf('Timeout') > 0) {
      console.log('Hey this looks like a timeout. Your project must be big. ' +
                  'Increase the timeout by writing "pageRenderingTimeout: 60" ' +
                  'at the top of your config.yml. Default is 30 (seconds).')
    }
    return
  }

  timings.tLoad = performance.now()
  console.log(colors.magenta(`... Document loaded in ${((timings.tLoad - timings.tHTML) / 1000).toFixed(1)}s`))

  await waitForNetworkIdle(page, 200)
  timings.tNetwork = performance.now()
  console.log(colors.magenta(`... Network idled in ${((timings.tNetwork - timings.tLoad) / 1000).toFixed(1)}s`))

  // Get header/footer template
  var header = await page.$eval('#page-header', element => element.innerHTML)
    .catch(error => '')
  var footer = await page.$eval('#page-footer', element => element.innerHTML)
    .catch(error => '')

  if (header !== '' && footer === '') {
    footer = '<span></span>'
  }
  if ((footer !== '') && (header === '')) {
    header = '<span></span>'
  }
  /*
   *            Create PDF options
   */
  var options = {
    path: outputPath,
    displayHeaderFooter: !!(header || footer),
    headerTemplate: header,
    footerTemplate: footer,
    printBackground: true
  }

  function getMatch (string, query) {
    var result = string.match(query)
    if (result) {
      result = result[1]
    }
    return result
  }

  var width = getMatch(html, /-relaxed-page-width: (\S+);/m)
  if (width) {
    options.width = width
  }
  var height = getMatch(html, /-relaxed-page-height: (\S+);/m)
  if (height) {
    options.height = height
  }
  var size = getMatch(html, /-relaxed-page-size: (\S+);/m)
  if (size) {
    options.size = size
  }

  for (var pageModifier of pluginHooks.pageModifiers) {
    await pageModifier.instance(page)
  }

  for (pageModifier of pluginHooks.page2ndModifiers) {
    await pageModifier.instance(page)
  }

  // TODO: add option to output full html from page

  /*
   *            PRINT PAGE TO PDF
   */
  await page.pdf(options)

  timings.tPDF = performance.now()
  let duration = ((timings.tPDF - timings.tNetwork) / 1000).toFixed(1)
  let pdfSize = filesize(fs.statSync(outputPath).size)
  console.log(colors.magenta(`... PDF written in ${duration}s (${pdfSize})`))
}

exports.fileToPdf = fileToPdf
exports.browseToPage = browseToPage
exports.contentToHtml = contentToHtml
exports.renderDependencies = renderDependencies