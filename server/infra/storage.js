import fs from 'node:fs';
import path from 'node:path';
import {config} from '../config.js';

export function ensureStorageReady() {
  fs.mkdirSync(config.uploadDir, {recursive:true});
  const probe = path.join(config.uploadDir, `.write-probe-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  return {mode:config.storageMode, uploadDir:config.uploadDir};
}

export function writeUpload(filename, buffer) {
  const safe = path.basename(filename);
  const target = path.join(config.uploadDir, safe);
  fs.writeFileSync(target, buffer, {flag:'wx'});
  return target;
}

export function resolveUpload(filename) {
  return path.join(config.uploadDir, path.basename(filename));
}

export function storageHealth() {
  try {
    ensureStorageReady();
    return {ok:true, mode:config.storageMode};
  } catch (error) {
    return {ok:false, mode:config.storageMode, error:error.message};
  }
}
