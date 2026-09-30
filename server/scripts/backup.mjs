import {validateRuntimeConfig} from '../config.js';
import {createDatabaseBackup} from '../infra/backup.js';

const validation=validateRuntimeConfig({strict:false});
if(!validation.ok){ console.error(validation.errors.join('\n')); process.exit(1); }
const result=createDatabaseBackup();
console.log(JSON.stringify(result,null,2));
