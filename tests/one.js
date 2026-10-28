const {vm,S,secs,key,type}=require('./run.js');
const cmd=process.argv[2]||'date';
secs(1.6);
type(cmd+'\n'); secs(1.2);
console.log(vm.screenText().split('\n').slice(-12).filter(l=>l.trim()).join('\n'));
console.log('dead',vm.dead,vm.fault||'','pc=0x'+vm.pc.toString(16));
