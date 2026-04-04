// get-subscriber.js
exports.handler = async function(event) {
    const h = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (event.httpMethod !== 'POST') return {statusCode:405,headers:h,body:'Method not allowed'};
    const {email} = JSON.parse(event.body||'{}');
    if (!email) return {statusCode:400,headers:h,body:JSON.stringify({error:'Email required'})};
    const BASE = (process.env.SUPABASE_URL||'').replace(/\/$/,'');
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY||'';
    console.log('BASE:',BASE,'KEY_LEN:',KEY.length,'EMAIL:',email);
    if (!BASE||!KEY) return {statusCode:500,headers:h,body:JSON.stringify({error:'Missing env: BASE='+!!BASE+' KEY='+!!KEY})};
    try {
          const url = BASE+'/rest/v1/subscribers?email=eq.'+encodeURIComponent(email.trim().toLowerCase())+'&select=plan,status&limit=1';
          console.log('URL:',url);
          const res = await fetch(url,{headers:{'apikey':KEY,'Authorization':'Bearer '+KEY,'Accept':'application/json'}});
          const text = await res.text();
          console.log('RESULT:',res.status,text);
          let data; try{data=JSON.parse(text);}catch(e){return {statusCode:500,headers:h,body:JSON.stringify({error:'Parse error',raw:text})};}
          if (!Array.isArray(data)||data.length===0) return {statusCode:404,headers:h,body:JSON.stringify({error:'Not found',raw:text})};
          return {statusCode:200,headers:h,body:JSON.stringify(data[0])};
    } catch(err) {
          console.error('ERR:',err.message);
          return {statusCode:500,headers:h,body:JSON.stringify({error:err.message})};
    }
};
