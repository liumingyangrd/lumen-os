const {vm,S,secs,key,type}=require('./run.js');
function screen(){ console.log(vm.screenText().split('\n').filter(l=>l.trim()).join('\n')); }
secs(1.6);
type('help\n'); secs(0.6);
screen();
console.log('--- 状态 ---');
console.log('dead',vm.dead,vm.fault||'','cur',vm.rd32(S.cur));
