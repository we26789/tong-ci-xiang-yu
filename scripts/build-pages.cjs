const fs=require('node:fs');
const path=require('node:path');

function buildPages({output=path.join(__dirname,'..','_site'),onlineUrl=process.env.ONLINE_GAME_URL||''}={}){
  let metadata='<meta name="tcxy-hosting" content="pages">';
  if(onlineUrl){
    const url=new URL(onlineUrl);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(url.pathname))throw new Error('ONLINE_GAME_URL must be an HTTPS directory URL');
    const destination=url.origin+(url.pathname==='/'?'':url.pathname);
    metadata+='\n<meta name="tcxy-online-url" content="'+destination.replaceAll('&','&amp;').replaceAll('"','&quot;')+'">';
  }
  const source=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'index.html'),source.replace('<head>','<head>\n'+metadata));
  fs.writeFileSync(path.join(output,'.nojekyll'),'');
  return output;
}
if(require.main===module)console.log('Pages artifact: '+buildPages());
module.exports={buildPages};
