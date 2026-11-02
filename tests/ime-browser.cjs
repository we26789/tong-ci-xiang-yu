'use strict';
const {runSuite}=require('./experience-browser.cjs');
runSuite('ime').catch(error=>{console.error(error);process.exitCode=1;});
