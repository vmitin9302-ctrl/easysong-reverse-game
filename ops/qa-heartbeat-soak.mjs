import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch();
const origin = process.env.QA_WEB_URL || 'https://xn--80aadskjyjbavcy.xn--p1ai';
const api = process.env.QA_API_URL || 'https://bba4u5rl3fimpjhbrrqo.containers.yandexcloud.net';
try {
  const page = await browser.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async ({api,cycles}) => {
    const failures = [], durations = [];
    const request = async (path, token, method='GET', body) => {
      const started = performance.now();
      try {
        const response = await fetch(api + path, {method, headers:{'Content-Type':'application/json', ...(token?{'X-Player-Token':token}:{})}, ...(method==='POST'?{body:JSON.stringify(body || {})}:{})});
        durations.push(performance.now()-started);
        if (!response.ok) failures.push({status:response.status(),operation:path.split('/').at(-1)});
        return await response.json();
      } catch { failures.push({status:'network',operation:path.split('/').at(-1)}); return null; }
    };
    const room = await request('/v1/matches', null, 'POST');
    if (!room?.id) throw new Error('Cannot create soak room');
    const peer = await request('/v1/matches/join/'+room.invite_token,null,'POST');
    try {
      if (!peer?.player_token) throw new Error('Cannot join soak room');
      for (let i=0;i<cycles;i++) {
        // Exercise either side of the old five-second keep-alive boundary.
        await new Promise(r=>setTimeout(r,[4800,5000,5200,10000][i%4]));
        await Promise.all([room,peer].map(async player=> {
          await request('/v1/matches/'+room.id+'/heartbeat',player.player_token,'POST');
          await request('/v1/matches/'+room.id,player.player_token);
        }));
      }
    } finally { await request('/v1/matches/'+room.id+'/forfeit',room.player_token,'POST'); }
    durations.sort((a,b)=>a-b);
    return {cycles,requests:durations.length,failures,p95ms:Math.round(durations[Math.floor(durations.length*.95)]),maxMs:Math.round(durations.at(-1))};
  }, {api,cycles:Number(process.env.QA_SOAK_CYCLES || 20)});
  console.log(JSON.stringify(result));
  if(process.env.QA_SOAK_OUTPUT) await writeFile(process.env.QA_SOAK_OUTPUT,JSON.stringify(result,null,2));
  if(result.failures.length) process.exitCode=1;
} finally { await browser.close(); }
