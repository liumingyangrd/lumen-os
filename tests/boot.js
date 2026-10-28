const path = require('path');
const fs = require('fs');
const R = p => require(path.join(__dirname, '..', 'tools', p));
const { Machine } = R('vm.js');

const img = fs.readFileSync(path.join(__dirname, '..', 'dist', 'lumen.lmi'));
const vm = new Machine();
vm.loadImage(img);

function pump(ticks) {
  for (let i = 0; i < ticks; i++) {
    vm.ticks++;
    vm.raiseIRQ(0x20);
    let guard = 0;
    while (vm.run(200000) > 0 && guard++ < 400) { }
  }
}

pump(20);
console.log('dead:', vm.dead, vm.fault || '');
console.log('halted:', vm.halted, 'pc=0x' + vm.pc.toString(16));
console.log('=== 屏幕 ===');
console.log(vm.screenText());
