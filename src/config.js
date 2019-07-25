
exports.preConfigure = function preConfigure(useSandbox) {
// Google Chrome headless configuration
// See https://github.com/GoogleChrome/puppeteer/issues/3938 for disabled plugins yielding perf increase
    return {
        headless: true,
        args: (!useSandbox ? ['--no-sandbox'] : []).concat([
            '--disable-translate',
            '--disable-extensions',
            '--disable-sync'
        ])
    }
}