const plugins = require('../src/plugins')

const app = require('../src/server');
const fs = require('fs');

// Test imports
const chai = require('chai');
const chaiHttp = require('chai-http');

// Relaxed imports
const { preConfigure } = require('../src/config')

// Configure chai
chai.use(chaiHttp);
chai.should();

describe('Request to the report server', () => {

    before(async () => {

        var puppeteerConfig = preConfigure(false)

        var relaxedGlobals = {
          busy: false,
          config: {},
          configPlugins: [],
          basedir: '/home/dshunfenthal/dev/relaxed/ReLaXed-cato/report'
        }

        await plugins.initializePlugins()
        await plugins.updateRegisteredPlugins(relaxedGlobals, relaxedGlobals.basedir)

        app.set('puppeteerConfig', puppeteerConfig)
        app.set('relaxedGlobals', relaxedGlobals)

    });

    it('Can list available reports', (done) => {
        chai.request(app)
            .get('/reports')
            .end((err, res) => {
                res.should.have.status(200);
                res.body.should.be.a('array');
                res.body.should.be.lengthOf(2);
                done();
            });
    });

    it('Can generate a report', (done) => {
        let file = fs.readFileSync('test/hello.pug', 'utf8');
        chai.request(app)
            .post('/reports/cato')
            .send({'content': file})
            .end((err, res) => {
                res.should.have.status(200);
                console.log(res.text)
                done();
            });
    });
});