'use strict';
// Vercel entry point: every /api/* and /img/* request is routed here (see vercel.json).
const { boot } = require('../src/boot');

let ready;
module.exports = async (req, res) => {
  ready ||= boot().catch((err) => { ready = null; throw err; });
  try {
    const app = await ready;
    return app(req, res);
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
};
