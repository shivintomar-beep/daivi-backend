require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin pass';
const BUCKET = 'daivi-files';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.endsWith('.xlsx') || file.originalname.endsWith('.xls');
    cb(ok ? null : new Error('Only .xlsx / .xls files allowed.'), ok);
  },
});

app.use(cors());
app.use(express.json());

async function downloadFile(filename) {
  const { data, error } = await supabase.storage.from(BUCKET).download(filename);
  if (error) return null;
  return Buffer.from(await data.arrayBuffer());
}

async function uploadFile(filename, buffer) {
  const { error } = await supabase.storage.from(BUCKET).upload(filename, buffer, {
    upsert: true,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  if (error) { console.error('Supabase upload error:', error.message); return false; }
  return true;
}

async function getFileUpdatedAt(filename) {
  const { data } = await supabase.storage.from(BUCKET).list('', { search: filename });
  return data?.[0]?.updated_at || null;
}

function toJsDate(val) {
  if (!val && val !== 0) return null;
  if (val instanceof Date) return val;
  if (typeof val === 'number') return new Date((val - 25569) * 86400 * 1000);
  const d = new Date(val);
  return isNaN(d) ? null : d;
}

// Looks for Flat No or Floor to find where the table starts
const SR_PATTERNS = new Set(['sr no', 'sr. no.', 'srno', 's.no', 'sr', 'flat no', 'flat no.', 'floor']);

function findHeaderRow(rows) {
  for (let r = 0; r < Math.min(20, rows.length); r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (SR_PATTERNS.has(cell)) return { row: r, col: c };
    }
  }
  return null;
}

const META_COLS = new Set([
  'sr no', 'sr. no.', 'sr.no.', 'srno', 'sr no.', 's.no', 's.no.', 'sr',
  'flat no', 'flat no.', 'unit no', 'unit no.', 'unit', 'flat number', 'flat',
  'type', 'flat type', 'unit type',
  'sold / unsold', 'sold/unsold', 'sold status', 'status',
  'floor', 'wing', 'block', 'name', 'owner', 'owner name',
]);

function parseActivitySheet(worksheet) {
  const raw = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  const found = findHeaderRow(raw);
  if (!found) return [];

  const { row: hRow, col: hCol } = found;
  const rawHeaders = raw[hRow] || [];
  const headers = rawHeaders.slice(hCol).map((h) => String(h || '').trim());

  const activityCols = headers.filter(
    (h) => h && !META_COLS.has(h.toLowerCase().replace(/\s+/g, ' '))
  );

  const flats = [];

  for (let r = hRow + 1; r < raw.length; r++) {
    const row = raw[r] || [];
    const srVal = row[hCol];
    if (srVal === '' || srVal === null || srVal === undefined) continue;

    const rowMap = {};
    headers.forEach((h, i) => {
      if (h) rowMap[h] = row[hCol + i] !== undefined ? row[hCol + i] : '';
    });

    const col = (...keys) => {
      for (const k of keys) {
        for (const [h, v] of Object.entries(rowMap)) {
          if (h.toLowerCase().replace(/\s+/g, ' ') === k.toLowerCase()) return String(v ?? '').trim();
        }
      }
      return '';
    };

    const flatNo = col('flat no', 'flat no.', 'unit no', 'unit', 'flat number', 'flat', 'floor');
    
    // Skip empty rows, repeated headers, or Lobby summary rows
    const fLow = String(flatNo).trim().toLowerCase();
const srLow = String(col('sr no', 'sr. no.', 'srno', 's.no', 'sr')).trim().toLowerCase();
if (!flatNo || fLow === 'flat no' || fLow === 'sr no' || Number(flatNo) > 40000) continue;
if (fLow === 'total' || fLow === 'completed' || fLow === 'balance' || fLow.includes('weekly') || fLow.includes('|') || fLow.includes('flats')) continue;
if (srLow === 'total' || srLow === 'completed' || srLow === 'balance' || srLow.includes('weekly')) continue;

    const type = col('type', 'flat type', 'unit type');
    const soldStatus = col('sold / unsold', 'sold/unsold', 'status', 'sold status');
   const currentFlat = String(col('flat no', 'flat', 'floor')).toLowerCase();
const isLobbyRow = currentFlat.includes('floor') || currentFlat.includes('lobby');
const isUnsold = !isLobbyRow && String(soldStatus).trim().toLowerCase() !== 'sold';
    const tLow = String(type).toLowerCase();
    const isFinished = tLow.includes('finished');
    const isRaw = tLow.includes('raw') && !tLow.includes('internal');
    const activities = {};
    activityCols.forEach((act) => {
      let val = String(rowMap[act] ?? '').trim();
      const aLow = act.toLowerCase();
      if (isUnsold) {
        val = 'N/A'; // Ignore unsold flats entirely
      } else {
        // Rule: Only Raw Flats
        if (aLow.includes('con. plum') || aLow.includes('conc.plum')) {
          if (!isRaw) val = 'N/A';
        }
        // Rule: Only Finished Flats
        else if (aLow.includes('electrical') || aLow.includes('first coat') || aLow.includes('gypsum') || aLow.includes('guypsum') || aLow.includes('platform') || aLow.includes('undersunk') || aLow.includes('primer') || aLow.includes('putty') || aLow.includes('conduit') || aLow.includes('kitchen dado')) {
          if (!isFinished) val = 'N/A';
        }
        // Rule: Full Flat Flooring (Only Finished), but don't block Toilet Dado & Flooring
        else if (aLow.includes('tile/floo') || (aLow.includes('floor') && !aLow.includes('toilet'))) {
          if (!isFinished) val = 'N/A';
        }
      }
      activities[act] = val;
    });

     let floor = null;
    const digitsOnly = flatNo.replace(/\D/g, '');
    if (digitsOnly.length >= 3) {
      floor = Math.floor(parseInt(digitsOnly, 10) / 100);
    } else if (digitsOnly.length > 0) {
      floor = parseInt(digitsOnly, 10);
    }

    flats.push({ flatNo, type, soldStatus, floor, activities });
  }
  return flats;
}

function parseSchedule(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const colVal = (row, ...keys) => {
    for (const k of keys) {
      for (const [h, v] of Object.entries(row)) {
        if (String(h).trim().toLowerCase().replace(/\s+/g, ' ') === k.toLowerCase()) return v;
      }
    }
    return '';
  };

  return raw
    .map((row) => {
      const activity = String(colVal(row, 'activity', 'activity name', 'work', 'item') || Object.values(row)[0] || '').trim();
      const plannedStart = colVal(row, 'planned start', 'start date', 'start', 'from', 'begin');
      const plannedEnd   = colVal(row, 'planned end', 'planned finish', 'end date', 'finish date', 'finish', 'to', 'end');
      return {
        activity,
        plannedStart: toJsDate(plannedStart)?.toISOString().split('T')[0] || String(plannedStart),
        plannedEnd:   toJsDate(plannedEnd)?.toISOString().split('T')[0]   || String(plannedEnd),
      };
    })
    .filter((r) => r.activity);
}

function parseProgressLog(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return raw
    .map((row) => {
      const date = String(row['Date'] || row['date'] || '').trim();
      const pct  = parseFloat(row['Overall % Complete'] || row['percent'] || row['Percent'] || 0);
      return { date, percent: isNaN(pct) ? 0 : pct };
    })
    .filter((r) => r.date);
}

function buildProgressLogBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const wsData = [['Date', 'Overall % Complete'], ...rows.map((r) => [r.date, r.percent])];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'Progress Log');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Added 'p' to count the green P boxes as done!
const DONE_VALS = new Set(['done', 'complete', 'completed', 'yes', '✓', 'finished', 'ok', '1', 'true', 'p']);
const NA_VALS   = new Set(['n/a', 'na', 'not applicable', 'nil', '-', 'n.a', 'n.a.', 'unsold - not for sale']);

function calcStats(wings, schedule) {
  let totalFlats = 0, sold = 0, finished = 0;
  let totalSlots = 0, doneSlots = 0;
  const behindActivities = new Set();
  const today = new Date();

  const deadlines = {};
  (schedule || []).forEach((s) => {
    if (s.plannedEnd) {
      const d = new Date(s.plannedEnd);
      if (!isNaN(d)) deadlines[s.activity.toLowerCase()] = d;
    }
  });

  Object.values(wings).forEach((flats) => {
    flats.forEach((flat) => {
      totalFlats++;
      if (flat.soldStatus.toLowerCase() === 'sold') sold++;

      const actVals = Object.values(flat.activities);
      const nonNA   = actVals.filter((v) => !NA_VALS.has(String(v).toLowerCase().trim()));
      const allDone = nonNA.length > 0 && nonNA.every((v) => DONE_VALS.has(String(v).toLowerCase().trim()));
      if (allDone) finished++;

      Object.entries(flat.activities).forEach(([actName, val]) => {
        const v = String(val).toLowerCase().trim();
        if (NA_VALS.has(v)) return;
        totalSlots++;
        const isDone = DONE_VALS.has(v);
        if (isDone) doneSlots++;
        if (!isDone) {
          const deadline = deadlines[actName.toLowerCase()];
          if (deadline && today > deadline) behindActivities.add(actName);
        }
      });
    });
  });

  return {
    totalFlats,
    sold,
    unsold: totalFlats - sold,
    finished,
    overallPercent: totalSlots > 0 ? Math.round((doneSlots / totalSlots) * 1000) / 10 : 0,
    behindSchedule: behindActivities.size,
  };
}

app.get('/api/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: 'Incorrect password.' });
});

app.get('/api/data', async (_req, res) => {
  try {
    const dataBuf = await downloadFile('data.xlsx');
    if (!dataBuf) return res.status(404).json({ error: 'No data.xlsx uploaded yet.' });

    const dataWB = XLSX.read(dataBuf, { type: 'buffer' });
    const wings = {};
    const allActivityNames = new Set();

    dataWB.SheetNames.forEach((name) => {
      const flats = parseActivitySheet(dataWB.Sheets[name]);
      if (flats.length > 0) {
        wings[name] = flats;
        flats.forEach((f) => Object.keys(f.activities).forEach((a) => allActivityNames.add(a)));
      }
    });

    let schedule = [];
    const scheduleBuf = await downloadFile('schedule.xlsx');
    if (scheduleBuf) schedule = parseSchedule(XLSX.read(scheduleBuf, { type: 'buffer' }));

    let progressLog = [];
    const logBuf = await downloadFile('progress-log.xlsx');
    if (logBuf) progressLog = parseProgressLog(XLSX.read(logBuf, { type: 'buffer' }));

    const lastUpdated = await getFileUpdatedAt('data.xlsx') || new Date().toISOString();
    const summary     = calcStats(wings, schedule);

    res.json({ lastUpdated, summary, wings, activityNames: Array.from(allActivityNames), schedule, progressLog });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { password, fileType = 'data' } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });

    const filename = fileType === 'data' ? 'data.xlsx' : 'schedule.xlsx';
    const saved = await uploadFile(filename, req.file.buffer);
    if (!saved) return res.status(500).json({ error: 'Failed to save to storage.' });

    let overallPercent = null;
    if (fileType === 'data') {
      try {
        const dataWB = XLSX.read(req.file.buffer, { type: 'buffer' });
        const wings = {};
        dataWB.SheetNames.forEach((name) => {
          const flats = parseActivitySheet(dataWB.Sheets[name]);
          if (flats.length > 0) wings[name] = flats;
        });
        let schedule = [];
        const scheduleBuf = await downloadFile('schedule.xlsx');
        if (scheduleBuf) schedule = parseSchedule(XLSX.read(scheduleBuf, { type: 'buffer' }));
        
        overallPercent = calcStats(wings, schedule).overallPercent;

        let logRows = [];
        const logBuf = await downloadFile('progress-log.xlsx');
        if (logBuf) logRows = parseProgressLog(XLSX.read(logBuf, { type: 'buffer' }));

        const todayStr = new Date().toISOString().split('T')[0];
        logRows = logRows.filter((r) => r.date !== todayStr);
        logRows.push({ date: todayStr, percent: overallPercent });

        await uploadFile('progress-log.xlsx', buildProgressLogBuffer(logRows));
      } catch (logErr) {
        console.error(logErr.message);
      }
    }
    res.json({ success: true, message: `${filename} uploaded.`, overallPercent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Running on port ${PORT}`));
