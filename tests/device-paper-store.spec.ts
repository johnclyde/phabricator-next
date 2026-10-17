import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import type * as DevicePaperAPI from '../client/device-papers';

declare global { interface Window { devicePaperTest: typeof DevicePaperAPI } }
let bundle = '';
test.beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: resolve('client/device-papers.ts'), name: 'devicePaperTest', formats: ['iife'] } } });
  const builds = Array.isArray(result) ? result : [result];
  for (const item of builds) if ('output' in item) for (const output of item.output) if (output.type === 'chunk' && output.isEntry) bundle = output.code;
  if (!bundle) throw new Error('Device paper store browser bundle was not produced.');
});
async function load(page: Page) {
  await page.route('**/device-paper-store-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native device paper storage verification</title>' }));
  await page.goto('./device-paper-store-test'); await page.addScriptTag({ content: bundle });
}

test('native device saves survive reload offline and reject racing updates and deletes', async ({ page, context }) => {
  await load(page);
  const initial = await page.evaluate(async () => {
    const api = window.devicePaperTest, store = api.createDevicePaperStore(), paper = api.newDevicePaper('Exact source', [{ path: 'main.tex', content: 'a\r\nb\rc\n\\(x^2\\)' }]);
    const saved = await store.save(paper, null); store.close(); return saved;
  });
  await page.reload(); await page.addScriptTag({ content: bundle }); await context.setOffline(true);
  const result = await page.evaluate(async original => {
    const api = window.devicePaperTest, one = api.createDevicePaperStore(), two = api.createDevicePaperStore();
    const loaded = await one.read(original.id); if (!loaded) throw new Error('Missing persisted paper');
    const competing = await Promise.allSettled([one.save({ ...loaded, title: 'First contender' }, loaded.revision), two.save({ ...loaded, title: 'Second contender' }, loaded.revision)]);
    const success = competing.find(item => item.status === 'fulfilled'); if (!success || success.status !== 'fulfilled') throw new Error('No writer succeeded');
    const failure = competing.find(item => item.status === 'rejected');
    let staleDelete: unknown; try { await two.delete(original.id, loaded.revision); } catch (error) { staleDelete = error; }
    const current = await one.read(original.id); await one.delete(original.id, success.value.revision);
    let deletedSave: unknown; try { await two.save(success.value, success.value.revision); } catch (error) { deletedSave = error; }
    const result = { loaded, successes: competing.filter(item => item.status === 'fulfilled').length, conflict: failure?.status === 'rejected' && failure.reason instanceof api.DevicePaperConflictError, conflictRevision: failure?.status === 'rejected' ? failure.reason.current?.revision : null, staleDelete: staleDelete instanceof api.DevicePaperConflictError, current, deletedConflict: deletedSave instanceof api.DevicePaperConflictError && deletedSave.current === null, afterDelete: await two.read(original.id) };
    one.close(); two.close(); return result;
  }, initial);
  expect(result.loaded).toEqual(initial); expect(result.successes).toBe(1); expect(result.conflict).toBe(true); expect(result.conflictRevision).toBe(2); expect(result.staleDelete).toBe(true); expect(result.current?.revision).toBe(2); expect(result.deletedConflict).toBe(true); expect(result.afterDelete).toBe(null);
});

test('native transaction abort never reports a save and separate mounts preserve their papers', async ({ page }) => {
  await load(page);
  const result = await page.evaluate(async () => {
    const api = window.devicePaperTest, one = api.createDevicePaperStore({ basePath: '/one/' }), two = api.createDevicePaperStore({ basePath: '/two/' });
    const paper = api.newDevicePaper(), saved = await one.save(paper, null); await two.save({ ...paper, title: 'Other mount' }, null);
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) { const request = key === undefined ? nativePut.call(this, value) : nativePut.call(this, value, key); request.addEventListener('success', () => this.transaction.abort()); return request; };
    let failed = false; try { await one.save({ ...saved, title: 'Must not be saved' }, saved.revision); } catch { failed = true; } finally { IDBObjectStore.prototype.put = nativePut; }
    const afterAbort = await one.read(paper.id), separate = await two.read(paper.id);
    IDBObjectStore.prototype.put = function() { throw new DOMException('Test full disk', 'QuotaExceededError'); };
    let quota = false; try { await one.save({ ...saved, title: 'Full disk' }, saved.revision); } catch (cause) { quota = cause instanceof api.DevicePaperStorageError && cause.code === 'quota'; } finally { IDBObjectStore.prototype.put = nativePut; }
    one.close(); two.close(); return { saved, afterAbort, separate, failed, quota };
  });
  expect(result.failed).toBe(true); expect(result.quota).toBe(true); expect(result.afterAbort).toEqual(result.saved); expect(result.separate?.title).toBe('Other mount');
});
