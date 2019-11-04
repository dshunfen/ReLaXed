const pug = require('pug')
const colors = require('colors/safe')
const cheerio = require('cheerio')
const puppeteer = require('puppeteer')
const fs = require('fs')
const filesize = require('filesize')
const path = require('path')
const { performance } = require('perf_hooks')

fileToPdf = async function (masterPath, relaxedGlobals, tempHTMLPath, outputPath, locals, page, pugPath) {
  var timings = {t0: performance.now()}

  var html = await generateHtmlFromPath(masterPath, relaxedGlobals, locals, pugPath)

  timings.tHTML = performance.now()
  console.log(colors.magenta(`... HTML generated in ${((timings.tHTML - timings.t0) / 1000).toFixed(1)}s`))

  fs.writeFileSync(tempHTMLPath, html)

  return await renderPdf(relaxedGlobals, tempHTMLPath, outputPath, html, timings, page)
}

browseToPage = async function browseToPage(puppeteerConfig) {
  const browser = await puppeteer.launch(puppeteerConfig);
  const page = await browser.newPage();

  page.on('pageerror', function(err) {
    console.log(colors.red('Page error: ' + err.toString()));
  }).on('error', function(err) {
    console.log(colors.red('Error: ' + err.toString()));
  });
  return page;
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

async function generateHtml(pluginHooks, masterPug, locals, basedir) {
  var pluginPugHeaders = [];
  for (var pugHeader of pluginHooks.pugHeaders) {
    pluginPugHeaders.push(pugHeader.instance);
  }
  pluginPugHeaders = pluginPugHeaders.join('\n\n');

  var pugFilters = Object.assign(...pluginHooks.pugFilters.map(o => o.instance));
  var html = pug.render(pluginPugHeaders + '\n' + masterPug, Object.assign({}, locals ? locals : {}, {
    fs: fs,
    basedir: basedir,
    cheerio: cheerio,
    __root__: basedir,
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

async function generateHtmlFromPath(masterPath, relaxedGlobals, locals, pugPath) {
  var pluginHooks = relaxedGlobals.pluginHooks
  var html
  var masterPug
  if (masterPath.endsWith('.pug')) {
    masterPug = fs.readFileSync(masterPath, 'utf8')
    html = await generateHtml(pluginHooks, masterPug, locals, relaxedGlobals.basedir);
  } else if (pugPath) {
    const myPug = path.resolve(masterPath, `${pugPath}.pug`)
    masterPug = fs.readFileSync(myPug, 'utf8')
    html = await generateHtml(pluginHooks, masterPug, locals, masterPath);
  } else if (masterPath.endsWith('.html')) {
    html = fs.readFileSync(masterPath, 'utf8')
  } else if (path.resolve(masterPath, 'report.pug')) {
    masterPug = fs.readFileSync(path.resolve(masterPath, 'report.pug'), 'utf8')
    html = await generateHtml(pluginHooks, masterPug, locals, masterPath);
  }

  if (!html) {
    throw new Error("No HTML was generated or found!")
  }

  return html;
}

async function renderPdf(relaxedGlobals, tempHTMLPath, outputPath, html, timings, page) {
  var pluginHooks = relaxedGlobals.pluginHooks
  if (page === undefined) {
    console.error('puppeteer page was not passed or is undefined');
    throw 'puppeteer page was not passed or is undefined';
  }
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
  const pdf = await page.pdf(options);

  timings.tPDF = performance.now()
  let duration = ((timings.tPDF - timings.tNetwork) / 1000).toFixed(1)
  let pdfSize = filesize(fs.statSync(outputPath).size)
  console.log(colors.magenta(`... PDF written in ${duration}s (${pdfSize})`))
  return pdf;
}

exports.fileToPdf = fileToPdf
exports.browseToPage = browseToPage
