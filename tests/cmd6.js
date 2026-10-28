const {vm,S,secs,key,type}=require('./run.js');
secs(1.6);
type('snake\n'); secs(1.5);
key(130); secs(0.6);   // 下
key(132); secs(0.6);   // 右
console.log(vm.screenText().split('\n').slice(0,8).join('\n'));
console.log('...');
console.log(vm.screenText().split('\n').slice(20,24).join('\n'));
console.log('dead',vm.dead,vm.fault||'','cur',vm.rd32(S.cur));
