
exports.preConfigure = function preConfigure(useSandbox) {
// Google Chrome headless configuration
// See https://github.com/GoogleChrome/puppeteer/issues/3938 for disabled plugins yielding perf increase
    return {
        headless: true,
        args: (!useSandbox ? ['--no-sandbox'] : []).concat([
            '--disable-translate',
            '--disable-extensions',
            '--disable-sync'
        ]),
        // Source: https://docs.browserless.io/blog/2019/05/03/improving-puppeteer-performance.html
        userDataDir: './chromeDataDir',
        executablePath: 'google-chrome-unstable'
    }
}