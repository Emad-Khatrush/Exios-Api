const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers');
jest.mock('../../utils/qaEnvironment', () => ({ isQa: true }));
const files = require('../../utils/qaFiles');
const app = express();
app.use('/api/qa-files', files.router);
const originalOrigin = process.env.QA_PUBLIC_API_URL;
beforeAll(async () => { process.env.QA_PUBLIC_API_URL = 'http://localhost'; await startDb(); });
afterAll(async () => { await stopDb(); if (originalOrigin === undefined) delete process.env.QA_PUBLIC_API_URL; else process.env.QA_PUBLIC_API_URL = originalOrigin; });
const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
const put = () => files.upload({ originalname: 'receipt.png', mimetype: 'image/png', buffer: png }, 'wallets');
const route = file => new URL(file.publicUrl).pathname;

test('upload is complete and durable before returning; receipt downloads byte for byte', async () => {
  const file = await put();
  const res = await request(app).get(route(file)).expect(200);
  expect(res.body.equals(png)).toBe(true);
  expect(res.headers['content-type']).toContain('image/png');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(file.bytes).toBe(String(png.length));
});
test('missing or incorrect capability cannot read a receipt', async () => {
  const file = await put();
  const parts = route(file).split('/');
  parts[parts.length - 1] = 'A'.repeat(43);
  await request(app).get(parts.join('/')).expect(404);
  await request(app).get('/api/qa-files/not-an-id/no-token').expect(404);
});
test('HTML disguised as an image is served as a download, never active HTML', async () => {
  const file = await files.upload({ originalname: 'bad.png', mimetype: 'image/png', buffer: Buffer.from('<script>alert(1)</script>') }, 'wallets');
  const res = await request(app).get(route(file)).expect(200);
  expect(res.headers['content-type']).toContain('application/octet-stream');
  expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  expect(res.headers['content-security-policy']).toContain('sandbox');
});
test('only an authorized file URL can delete the stored object and chunks', async () => {
  const file = await put();
  await files.remove(file.publicUrl.replace(/.$/, '!'));
  await request(app).get(route(file)).expect(200);
  await files.remove(file.publicUrl);
  await request(app).get(route(file)).expect(404);
  const id = new mongoose.Types.ObjectId(route(file).split('/')[3]);
  expect(await mongoose.connection.db.collection('qaAttachments.chunks').countDocuments({ files_id: id })).toBe(0);
});
test('empty and oversized uploads fail without creating a stored file', async () => {
  await expect(files.upload({ buffer: Buffer.alloc(0) }, 'wallets')).rejects.toThrow('Invalid file');
  await expect(files.upload({ buffer: Buffer.alloc(25 * 1024 * 1024 + 1) }, 'wallets')).rejects.toThrow('25 MB');
});
