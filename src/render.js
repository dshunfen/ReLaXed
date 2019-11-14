const pug = require('pug')
const colors = require('colors/safe')
const cheerio = require('cheerio')
const puppeteer = require('puppeteer')
const fs = require('fs')
const filesize = require('filesize')
const path = require('path')
const { performance } = require('perf_hooks')


async function browseToPage(puppeteerConfig) {
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

async function generateHtml(pluginHooks, masterPug, locals, pugPath, basedir) {
  var pluginPugHeaders = [];
  for (var pugHeader of pluginHooks.pugHeaders) {
    pluginPugHeaders.push(pugHeader.instance);
  }
  pluginPugHeaders = pluginPugHeaders.join('\n\n');

  var pugFilters = Object.assign(...pluginHooks.pugFilters.map(o => o.instance));
  var html = pug.render(pluginPugHeaders + '\n' + masterPug, Object.assign({}, locals ? locals : {}, {
    filename: pugPath,
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

async function generateHtmlFromPath(masterPath, relaxedGlobals, locals) {
  var timings = {t0: performance.now()}

  var pluginHooks = relaxedGlobals.pluginHooks
  var html
  // If we've specified HTML, then we don't need to render pug
  if (masterPath.endsWith('.html')) {
    html = fs.readFileSync(masterPath, 'utf8')
  } else {
    let pugPath = masterPath;
    if (!masterPath.endsWith('.pug')) { // We've already specified the pug to render
      pugPath = autodetectMasterFile(masterPath)
    }
    const pugContent = fs.readFileSync(pugPath, 'utf8')
    if(pugPath && pugContent) {
      const basedir = masterPath || relaxedGlobals.basedir;
      html = await generateHtml(pluginHooks, pugContent, locals, pugPath, basedir);
    }
  }

  if (!html) {
    throw new Error("No HTML was generated or found!")
  }

  timings.tHTML = performance.now()
  console.log(colors.magenta(`... HTML generated in ${((timings.tHTML - timings.t0) / 1000).toFixed(1)}s`))

  return html;
}

async function renderPdf(relaxedGlobals, htmlPath, outputPath, page) {
  var timings = {t0: performance.now()}

  var pluginHooks = relaxedGlobals.pluginHooks
  if (page === undefined) {
    console.error('puppeteer page was not passed or is undefined');
    throw 'puppeteer page was not passed or is undefined';
  }
  /*
   *            LOAD HTML
   */
  try {
    await page.goto('file:' + htmlPath, {
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
  console.log(colors.magenta(`... Document loaded in ${((timings.tLoad - timings.t0) / 1000).toFixed(1)}s`))

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

  if (relaxedGlobals.pageWidth) {
    options.width = relaxedGlobals.pageWidth
  }
  if (relaxedGlobals.pageHeight) {
    options.height = relaxedGlobals.pageHeight
  }
  if (relaxedGlobals.pageSize) {
    options.size = relaxedGlobals.pageSize
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

function autodetectMasterFile (renderPath) {
  var dir = renderPath || '.'
  var basenamePug = `${path.basename(renderPath)}.pug`
  var files = fs.readdirSync(dir).filter((name) => name.endsWith('.pug'))
  var filename
  if (files.length === 1) {
    filename = files[0]
  } else if (files.indexOf(basenamePug) >= 0) {
    filename = basenamePug
  } else if (files.indexOf('master.pug') >= 0) {
    filename = 'master.pug'
  } else {
    var error
    if (renderPath) {
      error = `Could not find a master file in the provided directory ${renderPath}`
    } else {
      error = `No input provided and could not find a master file in the current directory`
    }
    console.log(colors.red.bold(error))
    return
  }
  return path.join(dir, filename)
}

exports.autodetectMasterFile = autodetectMasterFile
exports.renderPdf = renderPdf
exports.browseToPage = browseToPage
exports.generateHtmlFromPath = generateHtmlFromPath
