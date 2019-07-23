const app = require('../src/app');

// Test imports
const chai = require('chai');
const chaiHttp = require('chai-http');

// Configure chai
chai.use(chaiHttp);
chai.should();

describe('Request to the report server', () => {

    before(() => {
        app.set('basedir', '/home/dshunfenthal/dev/relaxed/ReLaXed-cato');

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
    chai.request(app)
        .get('/reports/cato')
        .query({'param': 'par'})
        .end((err, res) => {
            res.should.have.status(200);
            console.log(res.body)
            done();
        });
    });
});