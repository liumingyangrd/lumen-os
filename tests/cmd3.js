const {vm,S,secs,key,type}=require('./run.js');
secs(1.6);
function run(cmd, wait){ type(cmd+'\n'); secs(wait||0.9); }
run('cat notes.txt');
console.log('==== cat ====');
console.log(vm.screenText().split('\n').slice(-13).join('\n'));
run('date'); console.log('==== date ===='); console.log(vm.screenText().split('\n').slice(-7).join('\n'));
run('mem'); console.log('==== mem ===='); console.log(vm.screenText().split('\n').slice(-11).join('\n'));
run('ps'); console.log('==== ps ===='); console.log(vm.screenText().split('\n').slice(-11).join('\n'));
run('hello'); console.log('==== hello ===='); console.log(vm.screenText().split('\n').slice(-8).join('\n'));
console.log('dead',vm.dead,vm.fault||'');
