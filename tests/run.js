/* 模拟浏览器时序: 每 10ms 一个 tick, 每个 tick 限预算 */
const path=require('path'), fs=require('fs');
const R=p=>require(path.join(__dirname,'..','tools',p));
const {Machine}=R('vm.js');
const img=fs.readFileSync(path.join(__dirname,'..','dist','lumen.lmi'));
const vm=new Machine(); vm.loadImage(img);
const S=JSON.parse(fs.readFileSync(path.join(__dirname,'..','dist','syms.json'),'utf8'));

function tick(budget){ vm.ticks++; vm.raiseIRQ(0x20); let g=0; while(vm.run(budget)>0 && g++<12){} }
function secs(s,budget){ const t=Math.round(s*100); for(let i=0;i<t;i++) tick(budget||120000); }
function key(code){ vm.keyQueue.push(code); vm.raiseIRQ(0x21); }
function type(str){
  const map={' ':'41',a:'1',b:'2',c:'3',d:'4',e:'5',f:'6',g:'7',h:'8',i:'9',j:'10',k:'11',l:'12',m:'13',n:'14',o:'15',p:'16',q:'17',r:'18',s:'19',t:'20',u:'21',v:'22',w:'23',x:'24',y:'25',z:'26'};
  for(const ch of str){
    if(ch==='\n'){ key(37); continue; }
    const punct={'.':45,'-':42,'/':46,'=':43,',':44,';':47,'_':42};
    if(punct[ch]){ key(punct[ch]); continue; }
    const c=map[ch.toLowerCase()]; if(c) key(parseInt(c));
  }
}
module.exports={vm,S,tick,secs,key,type};
if(require.main===module){
  secs(2);
  console.log(vm.screenText());
  console.log('pc=0x'+vm.pc.toString(16),'dead',vm.dead,vm.fault||'','cur',vm.rd32(S.cur));
}
