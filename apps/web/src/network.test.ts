// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithDeadline } from './network';
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();});
it('aborts a stalled upload without requiring AbortSignal.timeout', async () => {
 vi.useFakeTimers();
 vi.stubGlobal('fetch', vi.fn((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))));
 const pending=expect(fetchWithDeadline('/upload',{method:'PUT'},20000)).rejects.toMatchObject({name:'AbortError'});
 await vi.advanceTimersByTimeAsync(20000);await pending;expect(vi.getTimerCount()).toBe(0);
});

it('keeps the deadline until the audio response body has finished', async () => {
 vi.useFakeTimers();
 vi.stubGlobal('fetch', vi.fn(async (_url,init)=>({blob:()=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))})));
 const pending=expect(fetchWithDeadline('/audio',{},20000,response=>response.blob())).rejects.toMatchObject({name:'AbortError'});
 await vi.advanceTimersByTimeAsync(20000);await pending;expect(vi.getTimerCount()).toBe(0);
});
