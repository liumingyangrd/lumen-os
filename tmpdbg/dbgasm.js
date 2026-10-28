const fs=require('fs');
const path=require('path');
const {assemble}=require(path.join(__dirname,'..','tools','x86asm.js'));
let s=fs.readFileSync(path.join(__dirname,'..','src','x86','stage1.s'),'utf8');
s=s.replace(/^KERNEL_SECTORS = .*$/m,'KERNEL_SECTORS = 44');
s=s.replace(/^KERNEL_HEAD = .*$/m,'KERNEL_HEAD = 2');
s=s.replace(/^PAYLOAD_LBA = .*$/m,'PAYLOAD_LBA = 96');
try{assemble(s);}catch(e){console.error(e.message);}
