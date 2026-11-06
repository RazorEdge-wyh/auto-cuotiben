#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli.js');

main(process.argv.slice(2)).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  process.stderr.write(`\ncuotiben: ${msg}\n`);
  if (process.env.CUOTIBEN_DEBUG) process.stderr.write(`${err && err.stack}\n`);
  process.exitCode = 1;
});
