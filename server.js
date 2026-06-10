const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const OUTPUT = path.join(__dirname, 'Output');
const QUEUE_FILE = path.join(__dirname, 'workspace', 'queue.json');
const LOG_DIR = path.join(__dirname, 'workspace', 'logs');

// Ensure dirs
[OUTPUT, path.join(__dirname, 'workspace'), LOG_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
if (!fs.existsSync(QUEUE_FILE)) fs.writeFileSync(QUEUE_FILE, '[]');

// ========== Pipeline Executor (Task Queue Mode) ==========
// Web submits tasks → writes to workspace/tasks/ → Claude session picks up and executes
const THUMB_DIR = path.join(__dirname, 'workspace', 'thumbnails');
const TASK_DIR = path.join(__dirname, 'workspace', 'tasks');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
if (!fs.existsSync(TASK_DIR)) fs.mkdirSync(TASK_DIR, { recursive: true });

const STEP_DEFS = [
  { name: '检索信息', outDir: '检索信息结果', file: (c) => `${c}检索信息结果.docx` },
  { name: 'PPT内容', outDir: 'PPT内容文件', file: (c) => `${c}出国培训课程文档` },
  { name: 'PPT课件', outDir: 'PPT课件', file: (c) => `${c}出国培训课件` },
];

function checkFiles(country, stepFlags) {
  const exist = [], missing = [];
  for (let i = 0; i < 3; i++) {
    if (!stepFlags[i]) continue;
    const p = path.join(OUTPUT, STEP_DEFS[i].outDir, STEP_DEFS[i].file(country));
    if (fs.existsSync(p)) exist.push(i); else missing.push(i);
  }
  return { exist, missing, allExist: missing.length === 0 };
}

// SSE clients
const sseClients = new Set();
function broadcast(msg) { for (const c of sseClients) c.write(`data: ${JSON.stringify(msg)}\n\n`); }

// ========== API Routes ==========

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  sseClients.add(res); req.on('close', () => sseClients.delete(res));
});

// Submit generation task — checks files, writes task for Claude session
app.post('/api/generate', (req, res) => {
  const { country, steps: stepFlags } = req.body;
  if (!country) return res.status(400).json({ error: 'Country required' });
  const steps = stepFlags || [true, true, true];
  const check = checkFiles(country, steps);

  const pptDir = path.join(OUTPUT, 'PPT课件', `${country}出国培训课件`);
  const existingFiles = (fs.existsSync(pptDir)) ? fs.readdirSync(pptDir).filter(f => f.endsWith('.pptx')) : [];

  if (check.allExist) {
    return res.json({ status: 'completed', country, check, files: existingFiles, message: '全部文件已就绪' });
  }

  // Write task file for Claude session to pick up
  const task = { country, steps, missing: check.missing.map(i => STEP_DEFS[i].name), created: new Date().toISOString() };
  const taskFile = path.join(TASK_DIR, `${country}_${Date.now().toString(36)}.json`);
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));

  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  const item = {
    id: path.basename(taskFile, '.json'), country, steps, status: 'pending',
    started: new Date().toISOString(), files: existingFiles, check,
    missingNames: check.missing.map(i => STEP_DEFS[i].name)
  };
  queue.push(item);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  broadcast({ type: 'new_task', country, missing: item.missingNames });

  res.json({ status: 'pending', country, check, taskFile: path.basename(taskFile), missingNames: item.missingNames });
});

// Get pending tasks (for Claude session to check)
app.get('/api/pending-tasks', (req, res) => {
  if (!fs.existsSync(TASK_DIR)) return res.json([]);
  const tasks = fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json')).map(f => {
    const t = JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf-8'));
    return { file: f, ...t };
  });
  res.json(tasks);
});

// Mark task as done
app.delete('/api/pending-tasks/:file', (req, res) => {
  const tf = path.join(TASK_DIR, req.params.file);
  if (fs.existsSync(tf)) { fs.unlinkSync(tf); return res.json({ ok: true }); }
  res.json({ ok: false });
});

// Get queue/status
app.get('/api/queue', (req, res) => {
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  res.json(queue.sort((a, b) => new Date(b.started) - new Date(a.started)));
});

// Get completed list
app.get('/api/completed', (req, res) => {
  const completed = [];
  const scanDir = (dir, type) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) {
        const files = fs.readdirSync(full).filter(x => x.endsWith('.pptx') || x.endsWith('.docx'));
        completed.push({ name: f, type, path: full, files, size: files.reduce((s, x) => s + fs.statSync(path.join(full, x)).size, 0), mtime: fs.statSync(full).mtime });
      }
    }
  };
  scanDir(path.join(OUTPUT, 'PPT课件'), 'PPT课件');
  scanDir(path.join(OUTPUT, 'PPT内容文件'), 'PPT内容');
  // 检索信息结果 contains .docx files, not directories
  if (fs.existsSync(path.join(OUTPUT, '检索信息结果'))) {
    for (const f of fs.readdirSync(path.join(OUTPUT, '检索信息结果'))) {
      if (f.endsWith('.docx')) {
        const full = path.join(OUTPUT, '检索信息结果', f);
        completed.push({ name: f, type: '检索信息', path: full, files: [f], size: fs.statSync(full).size, mtime: fs.statSync(full).mtime });
      }
    }
  }
  res.json(completed);
});

// Get preview (docx text extraction)
app.get('/api/preview/:country', (req, res) => {
  const { country } = req.params;
  const researchFile = path.join(OUTPUT, '检索信息结果', `${country}检索信息结果.docx`);
  if (fs.existsSync(researchFile)) {
    // Extract text from docx (unzip + parse XML)
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(researchFile);
      const xml = zip.readAsText('word/document.xml');
      const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      res.json({ preview: text.substring(0, 8000) });
    } catch (e) {
      res.json({ preview: `[解析失败] ${e.message}` });
    }
  } else {
    res.json({ preview: '检索文档不存在。请先生成。' });
  }
});

// Delete
app.delete('/api/delete/:country', (req, res) => {
  const { country } = req.params;
  const dirs = [
    path.join(OUTPUT, '检索信息结果', `${country}检索信息结果.docx`),
    path.join(OUTPUT, 'PPT内容文件', `${country}出国培训课程文档`),
    path.join(OUTPUT, 'PPT课件', `${country}出国培训课件`),
  ];
  let deleted = 0;
  for (const d of dirs) {
    try {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
        deleted++;
      }
    } catch (e) {}
  }
  res.json({ deleted, message: `Cleaned ${deleted} entries for ${country}` });
});

// Get logs
app.get('/api/logs/:id', (req, res) => {
  const logFile = path.join(LOG_DIR, `${req.params.id}.log`);
  if (fs.existsSync(logFile)) res.json({ log: fs.readFileSync(logFile, 'utf-8') });
  else res.json({ log: '' });
});

// Get thumbnail/file list for pptx
app.get('/api/thumbnails', (req, res) => {
  const country = req.query.country;
  if (!country) return res.json({ files: [] });
  const pptDir = path.join(OUTPUT, 'PPT课件', `${country}出国培训课件`);
  if (!fs.existsSync(pptDir)) return res.json({ files: [] });
  const files = fs.readdirSync(pptDir).filter(f => f.endsWith('.pptx'));
  res.json({ files: files.map(f => ({ name: f, size: fs.statSync(path.join(pptDir, f)).size })) });
});

// Batch import countries
app.post('/api/batch', async (req, res) => {
  const { countries, steps } = req.body;
  if (!countries || !countries.length) return res.status(400).json({ error: 'Countries required' });
  const results = [];
  for (const c of countries) {
    results.push({ country: c.trim(), status: 'queued' });
  }
  // Execute sequentially to avoid overwhelming
  const allResults = [];
  for (const r of results) {
    if (!r.country) continue;
    const item = await runPipeline(r.country, steps || [true, true, true]);
    allResults.push({ country: r.country, id: item.id, status: item.status });
  }
  res.json({ results: allResults });
});

// Download single country PPT as ZIP
app.get('/api/download/:country', (req, res) => {
  const { country } = req.params;
  const pptDir = path.join(OUTPUT, 'PPT课件', `${country}出国培训课件`);
  if (!fs.existsSync(pptDir)) return res.status(404).json({ error: 'PPT课件不存在' });
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const files = fs.readdirSync(pptDir).filter(f => f.endsWith('.pptx'));
  if (!files.length) return res.status(404).json({ error: '无PPT文件' });
  files.forEach(f => zip.addLocalFile(path.join(pptDir, f)));
  const zipName = `${country}出国培训课件.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"`);
  res.send(zip.toBuffer());
});

// Batch download multiple countries
app.post('/api/download-batch', (req, res) => {
  const { countries } = req.body;
  if (!countries || !countries.length) return res.status(400).json({ error: 'Countries required' });
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  let hasFiles = false;
  for (const country of countries) {
    const pptDir = path.join(OUTPUT, 'PPT课件', `${country}出国培训课件`);
    if (!fs.existsSync(pptDir)) continue;
    const files = fs.readdirSync(pptDir).filter(f => f.endsWith('.pptx'));
    files.forEach(f => zip.addLocalFile(path.join(pptDir, f), country + '/'));
    if (files.length) hasFiles = true;
  }
  if (!hasFiles) return res.status(404).json({ error: '无PPT文件' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="批量课件下载.zip"');
  res.send(zip.toBuffer());
});

// Modify and regenerate (save version, trigger re-run via queue)
app.post('/api/modify', (req, res) => {
  const { country, chapter, feedback } = req.body;
  const task = { country, chapter, feedback, created: new Date().toISOString(), status: 'pending' };
  const taskFile = path.join(TASK_DIR, `modify_${country}_${chapter || 'all'}_${Date.now().toString(36)}.json`);
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));
  res.json({ status: 'pending', message: `修改任务已提交: ${feedback}` });
});

// Serve thumbnails
app.use('/thumbnails', express.static(THUMB_DIR));

// Dashboard stats
app.get('/api/stats', (req, res) => {
  const completed = [];
  const pptDir = path.join(OUTPUT, 'PPT课件');
  if (fs.existsSync(pptDir)) {
    for (const f of fs.readdirSync(pptDir)) {
      const full = path.join(pptDir, f);
      if (fs.statSync(full).isDirectory()) {
        const files = fs.readdirSync(full).filter(x => x.endsWith('.pptx'));
        completed.push({ name: f, files: files.length, size: files.reduce((s, x) => s + fs.statSync(path.join(full, x)).size, 0) });
      }
    }
  }
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  res.json({
    completedCountries: completed.length,
    completedFiles: completed.reduce((s, c) => s + c.files, 0),
    totalSize: completed.reduce((s, c) => s + c.size, 0),
    inQueue: queue.filter(q => q.status === 'running').length,
  });
});

// Serve index.html for root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 外派培训课件管理系统\n   http://localhost:${PORT}\n`));
