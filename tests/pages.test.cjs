const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {buildPages}=require('../scripts/build-pages.cjs');

test('Pages publishes only the game and an explicit HTTPS online entry',()=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'tcxy-pages-'));
  try{
    buildPages({output,onlineUrl:'https://game.example.com'});
    assert.deepEqual(fs.readdirSync(output).sort(),['.nojekyll','index.html']);
    const html=fs.readFileSync(path.join(output,'index.html'),'utf8');
    assert.match(html,/<meta name="tcxy-hosting" content="pages">/);
    assert.match(html,/<meta name="tcxy-online-url" content="https:\/\/game.example.com">/);
    buildPages({output,onlineUrl:''});
    assert.doesNotMatch(fs.readFileSync(path.join(output,'index.html'),'utf8'),/name="tcxy-online-url" content=/);
    for(const onlineUrl of ['http://game.example.com','https://user:pass@game.example.com','https://game.example.com/path','https://game.example.com/?x=y','javascript:alert(1)']){
      assert.throws(()=>buildPages({output,onlineUrl}));
    }
  }finally{fs.rmSync(output,{recursive:true,force:true});}
});
