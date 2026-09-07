import {chromium,webkit,expect} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {transform} from 'esbuild';
import path from 'node:path';
const origin=process.env.QA_WEB_URL || 'https://xn--80aadskjyjbavcy.xn--p1ai';
const directory=path.resolve(process.env.QA_LOCAL_DIST || 'apps/web/dist');
const sdkResponse=await fetch('https://telegram.org/js/telegram-web-app.js', {signal:AbortSignal.timeout(20000)});
if(!sdkResponse.ok)throw new Error('Official Telegram SDK download failed');
const sdkSource=await sdkResponse.text();
const results=[];
for(const name of (process.env.QA_ENGINES || 'chromium,webkit').split(',')) {
 console.log('Checking engine: '+name);
 const browser=await ({chromium,webkit}[name]).launch();
 try {
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.route('https://telegram.org/js/telegram-web-app.js', async route=>{
    await new Promise(r=>setTimeout(r,1500));
    await route.fulfill({body:sdkSource,contentType:'text/javascript'});
  });
  await context.addInitScript(()=>{window.__violations=[];document.addEventListener('securitypolicyviolation',e=>window.__violations.push(e.effectiveDirective));});
  await context.route(origin+'/**', async route=> {
   const url=new URL(route.request().url());
   const file=path.resolve(directory,'.'+(url.pathname==='/'?'/index.html':url.pathname));
   if(!file.startsWith(directory+path.sep))return route.abort();
   try {
    let body=await readFile(file);
    if(url.searchParams.has('csp_probe'))body=Buffer.from(body.toString().replace('</body>', '<script>window.__injected=true</script><script src="https://example.invalid/injected.js"></script></body>'));
    await route.fulfill({body,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
   } catch {await route.continue();}
  });
  const page=await context.newPage();
  await page.goto(origin+'/?csp_probe=1');
  await expect(page.getByRole('button',{name:'🔗 Вдвоём на разных устройствах'})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.__violations.filter(x=>x==='script-src-elem').length)).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(()=>window.__injected)).toBeUndefined();
  await context.addInitScript(()=>{
    window.__telegramEvents=[];
    window.TelegramWebviewProxy={postEvent:(name)=>window.__telegramEvents.push(name)};
  });
  const telegram=await context.newPage();
  telegram.on('console',m=>{if(m.type()==='error')console.log(name+': '+m.text().slice(0,600));});
  telegram.on('requestfailed',r=>console.log(name+': '+r.failure()?.errorText+' '+new URL(r.url()).origin));
  await telegram.goto(origin+'/#tgWebAppVersion=9.0&tgWebAppPlatform=ios');
  await expect.poll(()=>telegram.evaluate(()=>window.__telegramEvents),{timeout:30000}).toContain('web_app_ready');
  await expect.poll(()=>telegram.evaluate(()=>window.__telegramEvents)).toContain('web_app_expand');
  expect(await telegram.evaluate(()=>window.__violations)).toEqual([]);
  const audio=await browser.newPage();
  await audio.goto('about:blank');
  const js=(await transform(await readFile('apps/web/src/audio/browserAudio.ts','utf8'),{loader:'ts',format:'iife',globalName:'gameAudio'})).code;
  await audio.addScriptTag({content:js});
  const capability=await audio.evaluate(()=>({context:typeof AudioContext,recorder:typeof MediaRecorder}));
  let pipeline={unsupported:true,...capability};
  if(capability.context==='function' && capability.recorder==='function'){
   await audio.evaluate(()=>{
    const button=document.createElement('button');button.textContent='Run audio';document.body.appendChild(button);
    button.onclick=async()=>{try {
    const ctx=gameAudio.createAudioContext(); await ctx.resume();
    const oscillator=ctx.createOscillator(), destination=ctx.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start();
    const mime=gameAudio.selectRecorderMimeType();
    const recorder=mime?new MediaRecorder(destination.stream,{mimeType:mime}):new MediaRecorder(destination.stream);
    const chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);
    const stopped=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=reject});
    recorder.start();await new Promise(r=>setTimeout(r,1500));recorder.stop();await stopped;oscillator.stop();
    const decoded=await gameAudio.decodeRecording(ctx,new Blob(chunks,{type:recorder.mimeType}));
    const reversed=gameAudio.reverseAudioBuffer(ctx,decoded);
    const wav=gameAudio.audioBufferToWav(reversed);
    const restored=await gameAudio.decodeRecording(ctx,wav);
    const output={mime:recorder.mimeType,duration:decoded.duration,wavBytes:wav.size,reversedDuration:restored.duration};
    await ctx.close();window.__audioResult=output;
    }catch(error){window.__audioResult={error:String(error)}}};
   });
   await audio.getByText('Run audio').click();
   await expect.poll(()=>audio.evaluate(()=>window.__audioResult),{timeout:30000}).toBeDefined();
   pipeline=await audio.evaluate(()=>window.__audioResult);
   expect(pipeline.duration).toBeGreaterThan(.5);expect(pipeline.wavBytes).toBeGreaterThan(44);
  }else if(process.env.QA_REQUIRE_AUDIO==='true')throw new Error(name+' lacks audio APIs');
  results.push({engine:name,strictCspBlocksInjection:true,officialTelegramSdkWithSimulatedBridge:true,audio:pipeline});
 } finally{await browser.close();}
}
console.log(JSON.stringify(results));
if(process.env.QA_SECURITY_OUTPUT)await mkdir(path.dirname(process.env.QA_SECURITY_OUTPUT),{recursive:true});
if(process.env.QA_SECURITY_OUTPUT)await writeFile(process.env.QA_SECURITY_OUTPUT,JSON.stringify(results,null,2));
