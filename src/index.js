#!/usr/bin/env node

const colors = require('colors/safe')
const program = require('commander')
const chokidar = require('chokidar')
const yaml = require('js-yaml')
const { performance } = require('perf_hooks')
const path = require('path')
const fs = require('fs')
const fg = require('fast-glob')
const plugins = require('./plugins')
const { generateHtmlFromPath, renderPdf, browseToPage, autodetectMasterFile } = require('./render')
const { preConfigure } = require('./config')

var input, output
const version = require('../package.json').version

program
  .version(version)
  .usage('<input> [output] [options]')
  .arguments('<input> [output] [options]')
  .option('--no-sandbox', 'disable puppeteer sandboxing')
  .option('-w, --watch <locations>', 'Watch other locations', [])
  .option('-t, --temp [location]', 'Directory for temp file')
  .option('--bo, --build-once', 'Build once only, do not watch')
  .option('-l, --locals <json>', 'Json locals for pug rendering')
  .option('--h, --html-only', 'Only build the HTML and not the PDF')
  .option('--basedir <location>', 'Base directory for absolute paths, e.g. /')

  .action(function (inp, out) {
    input = inp
    output = out
  })

// ARGUMENTS PARSING AND SETUP

program.parse(process.argv)

if (!input || fs.lstatSync(input).isDirectory()) {
  input = autodetectMasterFile(input)
  if(!input) {
    program.help()
    process.exit(1)
  }
}

const inputPath = path.resolve(input)
const inputDir = path.resolve(inputPath, '..')
const inputFilenameNoExt = path.basename(input, path.extname(input))

var configPath
for (var filename of ['config.yml', 'config.json']) {
  let possiblePath = path.join(inputDir, filename)
  if (fs.existsSync(possiblePath)) {
    configPath = possiblePath
  }
}


// Output file, path, and temp html path
if (!output) {
  output = path.join(inputDir, inputFilenameNoExt + '.pdf')
}
const outputPath = path.resolve(output)

var tempDir
if (program.temp) {
  var validTempPath = fs.existsSync(program.temp) && fs.statSync(program.temp).isDirectory()

  if (validTempPath) {
    tempDir = path.resolve(program.temp)
  } else {
    console.error(colors.red('ReLaXed error: Could not find specified --temp directory: ' +
      program.temp))
    process.exit(1)
  }
} else {
  tempDir = inputDir
}

const tempHTMLPath = path.join(tempDir, inputFilenameNoExt + '_temp.htm')

// Default and additional watch locations
let watchLocations = [inputDir]
if (program.watch) {
  watchLocations = watchLocations.concat(program.watch)
}

let locals
if (program.locals) {
  try {
    locals = JSON.parse(program.locals)
  } catch (e) {
    console.error(e)
    colors.red('ReLaXed error: Could not parse locals JSON, see above.')
  }
}

let puppeteerConfig = preConfigure(program.sandbox)

/*
 * ==============================================================
 *                         MAIN
 * ==============================================================
 */

const relaxedGlobals = {
  busy: false,
  config: {},
  configPlugins: [],
  basedir: program.basedir || inputDir
}

var updateConfig = async function () {
  if (configPath) {
    console.log(colors.magenta('... Reading config file'))
    var data = await fs.readFile(configPath, 'utf8')
    if (configPath.endsWith('.json')) {
      relaxedGlobals.config = JSON.parse(data)
    } else {
      relaxedGlobals.config = yaml.safeLoad(data)
    }
  }
  await plugins.updateRegisteredPlugins(relaxedGlobals, inputDir)
}

renderDependencies = async function renderDependencies(p, relaxedGlobals, page) {
  let pluginExtMap = relaxedGlobals.pluginExtensionMapping;
  let extensions = Object.keys(pluginExtMap).map(key => path.join(p, '**','*' + key));
  const stream = fg.stream(extensions, { dot: true });
  let notifiedOfDependencies = false;

  for await (const sourceFile of stream) {
    for (let [key, item] of Object.entries(pluginExtMap)) {
      if (sourceFile.endsWith(key)) {
        let renderedFile = sourceFile.substr(0, sourceFile.length - key.length) + item;
        if (!fs.existsSync(renderedFile)) {
          if (!notifiedOfDependencies) {
            console.log(colors.magenta.bold('\nRendering dependencies...'))
            notifiedOfDependencies = true;
          }
          await build(sourceFile, page);
        }
      }
    }
  }
}

async function main () {
  console.log(colors.magenta.bold('Launching ReLaXed...'))

  await plugins.initializePlugins()
  await updateConfig()

  const page = await browseToPage(puppeteerConfig);

  await renderDependencies(inputDir, relaxedGlobals, page)

  await build(inputPath, page)

  if (program.buildOnce) {
    process.exit(0)
  } else {
    watch(page)
  }
}

/*
 * ==============================================================
 *                         BUILD
 * ==============================================================
 */

async function build (filepath, page) {
  var shortFileName = filepath.replace(inputDir, '')
  if ((path.basename(filepath) === 'config.yml') || (filepath.endsWith('.plugin.js'))) {
    await updateConfig()
    return
  }
  // Ignore the call if ReLaXed is already busy processing other files.

  if (!(relaxedGlobals.watchedExtensions.some(ext => filepath.endsWith(ext)))) {
    if (!(['.pdf', '.htm'].some(ext => filepath.endsWith(ext)))) {
      console.log(colors.grey(`No process defined for file ${shortFileName}.`))
    }
    return
  }

  if (relaxedGlobals.busy) {
    console.log(colors.grey(`File ${shortFileName}: ignoring trigger, too busy.`))
    return
  }

  console.log(colors.magenta.bold(`\nProcessing ${shortFileName}...`))
  relaxedGlobals.busy = true
  var t0 = performance.now()


  var taskPromise = null

  for (var watcher of relaxedGlobals.pluginHooks.watchers) {
    if (watcher.instance.extensions.some(ext => filepath.endsWith(ext))) {
      taskPromise = watcher.instance.handler(filepath, page)
      break
    }
  }

  if (!taskPromise) {
    let html = await generateHtmlFromPath(inputPath, relaxedGlobals, locals)
    fs.writeFileSync(tempHTMLPath, html);
    taskPromise = renderPdf(relaxedGlobals, tempHTMLPath, outputPath, page)
  }
  await taskPromise
  var duration = ((performance.now() - t0) / 1000).toFixed(2)
  console.log(colors.magenta.bold(`... Done in ${duration}s`))
  relaxedGlobals.busy = false
}

/**
 * Watch `watchLocations` paths for changes and continuously rebuild
 */

/*
 * ==============================================================
 *                         WATCH
 * ==============================================================
 */

function watch (page) {
  console.log(colors.magenta(`\nNow idle and waiting for file changes.`))
  chokidar.watch(watchLocations, {
    awaitWriteFinish: {
      stabilityThreshold: 50,
      pollInterval: 100
    }
  }).on('change', path => build(path, page))
}

main()
