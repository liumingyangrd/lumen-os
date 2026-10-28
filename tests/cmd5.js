const {vm,S,secs,key,type}=require('./run.js');
function shiftKey(code){ key(57); key(code); key(58); }
function tap(code, wait){ key(code); secs(wait||0.12); }
secs(1.6);
type('calc\n'); secs(0.8);
// (3+4)*5-2
shiftKey(36); tap(27); tap(42); tap(31); shiftKey(27); shiftKey(42); tap(32); tap(42); tap(29);
tap(43);   // '-'  → 实际是 '-' 键
secs(0.3);
tap(37); secs(0.6);
console.log(vm.screenText().split('\n').slice(-10).filter(l=>l.trim()).join('\n'));
console.log('dead',vm.dead,vm.fault||'');
