import fs from 'node:fs';
import path from 'node:path';
import {config} from '../config.js';
import {db} from '../db.js';

function sqlQuote(value) { return String(value).replaceAll("'", "''"); }

export function createDatabaseBackup() {
  fs.mkdirSync(config.backupDir, {recursive:true});
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const target = path.join(config.backupDir, `meetmart-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${sqlQuote(target)}'`);
  const entries = fs.readdirSync(config.backupDir)
    .filter(name=>/^meetmart-.*\.sqlite$/.test(name))
    .map(name=>({name,path:path.join(config.backupDir,name),mtime:fs.statSync(path.join(config.backupDir,name)).mtimeMs}))
    .sort((a,b)=>b.mtime-a.mtime);
  for (const old of entries.slice(config.backupRetention)) {
    try { fs.unlinkSync(old.path); } catch {}
  }
  return {path:target,sizeBytes:fs.statSync(target).size,createdAt:new Date().toISOString()};
}

export function startBackupScheduler(logger = console) {
  if (!config.backupEnabled || config.backupIntervalHours <= 0) return () => {};
  const interval = Math.max(1, config.backupIntervalHours) * 60 * 60 * 1000;
  const timer = setInterval(()=>{
    try { const result=createDatabaseBackup(); logger.info?.(`[meetmart-backup] created ${result.path} (${result.sizeBytes} bytes)`); }
    catch(error){ logger.error?.('[meetmart-backup] failed:',error.message); }
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}
