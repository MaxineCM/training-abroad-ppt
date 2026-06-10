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

// ========== Pipeline Executor ==========
const THUMB_DIR = path.join(__dirname, 'workspace', 'thumbnails');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

async function runClaudeCommand(prompt) {
  return new Promise((resolve) => {
    exec(`claude -p "${prompt.replace(/"/g, '\\"')}" --no-confirm 2>&1`, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, output: (stdout || '').substring(0, 5000), error: err ? err.message : null });
    });
  });
}

async function runPipeline(country, stepFlags) {
  const id = Date.now().toString(36);
  const log = (msg) => { const l = `[${new Date().toLocaleTimeString()}] ${msg}\n`; fs.appendFileSync(path.join(LOG_DIR, `${id}.log`), l); return l; };
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  const item = { id, country, steps: stepFlags, status: 'running', step: 0, started: new Date().toISOString(), files: [], logs: [] };
  queue.push(item);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));

  const stepDefs = [
    { name: '检索信息', cmd: `/training-abroad-research ${country}`, outDir: '检索信息结果', file: `${country}检索信息结果.docx` },
    { name: 'PPT内容', cmd: `/ppt-content-generator 生成${country}课程内容`, outDir: 'PPT内容文件', file: `${country}出国培训课程文档` },
    { name: 'PPT课件', cmd: `/ppt-generator 生成${country}PPT课件`, outDir: 'PPT课件', file: `${country}出国培训课件` },
  ];

  try {
    for (let i = 0; i < 3; i++) {
      if (!stepFlags[i]) continue;
      const def = stepDefs[i];
      item.step = i + 1;
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));

      const outPath = path.join(OUTPUT, def.outDir, def.file);
      if (fs.existsSync(outPath)) {
        const msg = `[Step ${i+1}/3] ${def.name} - 已存在，跳过`;
        log(msg); item.logs.push(msg);
      } else {
        const msg = `[Step ${i+1}/3] ${def.name} - 执行: ${def.cmd}`;
        log(msg); item.logs.push(msg);

        const result = await runClaudeCommand(def.cmd);
        if (result.ok) {
          const okMsg = `✅ ${def.name} 完成`;
          log(okMsg); item.logs.push(okMsg);
        } else {
          const errMsg = `⚠️ ${def.name} CLI 不可用，请在 Claude Code 中手动执行: ${def.cmd}`;
          log(errMsg); item.logs.push(errMsg);
        }
      }
    }

    item.status = 'completed';
    item.completed = new Date().toISOString();
    const pptDir = path.join(OUTPUT, 'PPT课件', `${country}出国培训课件`);
    if (fs.existsSync(pptDir)) item.files = fs.readdirSync(pptDir).filter(f => f.endsWith('.pptx'));

  } catch (e) {
    log(`ERROR: ${e.message}`);
    item.status = 'failed'; item.error = e.message;
  }
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  return item;
}

// Generate thumbnails for a pptx file
async function genThumbnail(pptxPath, country, chapter) {
  const thumbName = `${country}_${chapter}.jpg`;
  const thumbPath = path.join(THUMB_DIR, thumbName);
  if (fs.existsSync(thumbPath)) return `/thumbnails/${thumbName}`;
  return new Promise((resolve) => {
    exec(`python ".claude/skills/pptx/scripts/thumbnail.py" "${pptxPath}" "${path.join(THUMB_DIR, country + '_' + chapter)}" --cols 3 2>&1`, { timeout: 30000 }, (err) => {
      resolve(err ? null : `/thumbnails/${thumbName}`);
    });
  });
}

// ========== API Routes ==========

// Submit generation task
app.post('/api/generate', async (req, res) => {
  const { country, steps } = req.body; // steps = [true, true, true] for full pipeline
  if (!country) return res.status(400).json({ error: 'Country required' });
  const item = await runPipeline(country, steps || [true, true, true]);
  res.json({ id: item.id, message: `Task ${item.id} completed`, status: item.status });
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
  scanDir(path.join(OUTPUT, '检索信息结果'), '检索信息');
  scanDir(path.join(OUTPUT, 'PPT内容文件'), 'PPT内容');
  res.json(completed);
});

// Get preview (docx text extraction)
app.get('/api/preview/:country', (req, res) => {
  const { country } = req.params;
  const researchFile = path.join(OUTPUT, '检索信息结果', `${country}检索信息结果.docx`);
  if (fs.existsSync(researchFile)) {
    // Return text preview via markitdown
    exec(`python -m markitdown "${researchFile}"`, { timeout: 15000 }, (err, stdout) => {
      if (err) return res.json({ preview: `[无法预览] ${err.message}` });
      res.json({ preview: stdout.substring(0, 10000) });
    });
  } else {
    res.json({ preview: '文件不存在' });
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
