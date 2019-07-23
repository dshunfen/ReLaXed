const express = require('express')
const path = require('path')
const fg = require('fast-glob')
const relaxed = require('../generate')

const router = express.Router()

// Root page that just shows that we have our server
router.get('/', (req, res) => {
  res.send('You have reached the ReLaXed REST server')
})

router.get('/reports', async (req, res) => {
  let basedir = res.app.get('basedir');
  const entries = await fg([path.join(basedir, '*')], { onlyDirectories: true })
  res.send(entries)
})

router.get('/reports/:reportId', async (req, res) => {
  console.log(req.params.reportId)
  res.app.get()
  await relaxed.contentToHtml()
})

module.exports = router;

