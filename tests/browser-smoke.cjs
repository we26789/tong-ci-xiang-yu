'use strict';
const {runSuite}=require('./experience-browser.cjs');
runSuite('browser').catch(error=>{console.error(error);process.exitCode=1;});
