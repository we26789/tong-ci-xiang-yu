'use strict';
const {runSuite}=require('./experience-browser.cjs');
runSuite('focus').catch(error=>{console.error(error);process.exitCode=1;});
