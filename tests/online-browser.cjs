'use strict';
const {runSuite}=require('./experience-browser.cjs');
runSuite('online').catch(error=>{console.error(error);process.exitCode=1;});
