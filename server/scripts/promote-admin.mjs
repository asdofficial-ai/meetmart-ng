import {db} from '../db.js';
const email=String(process.argv[2]||'').trim().toLowerCase();
if(!email){console.error('Usage: npm run api:promote-admin -- user@example.com');process.exit(1);}
const result=db.prepare("UPDATE users SET role='admin' WHERE email=?").run(email);
if(Number(result.changes)!==1){console.error('No matching user found. Create the account first.');process.exit(1);}
console.log(`Promoted ${email} to admin.`);
